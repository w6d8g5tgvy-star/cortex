'use strict';
// The SmartSave background service inside a running Cortex: watches enabled project folders, saves after a quiet
// period (debounce) or at the latest every interval, reacts to agent hooks (before compaction, out of tokens, session
// end), to verified usage limits (75% / 90%) and to Cortex updates, uploads in the background, and prunes daily.
// Ordinary saves use zero AI tokens.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SmartSave } = require('./index');
const { SKIP_DIRS } = require('./scan');

function startService({ vault, store, conf, log = () => {}, onChange = () => {} }) {
  const home = path.join(vault, '.cortex', 'smartsave');
  const ss = new SmartSave({ home, store, device: (conf().smartsave && conf().smartsave.device) || os.hostname(), config: () => conf().smartsave });
  const trigDir = path.join(home, 'triggers');
  const watchers = new Map(); // slug -> { root, w }
  const lastEvent = {}; let lastPrune = 0; let usageBand = {}; let usageCheck = 0;
  const metrics = { checkpoints: 0, lastMs: 0, uploads: 0, errors: 0, lastError: null };

  const markDirty = (slug) => { const now = Date.now(); if (!ss.dirtyAt[slug]) ss.dirtyAt[slug] = now; lastEvent[slug] = now; };
  const relevant = (rel) => { if (!rel) return true; const parts = String(rel).split(/[\\/]/); return !parts.some((p) => SKIP_DIRS.has(p)); };

  function syncWatchers() {
    const want = new Map(ss.enabledProjects().map((s) => [s, path.resolve(ss.projectRoot(s))]));
    for (const [slug, w] of watchers) if (want.get(slug) !== w.root) { try { w.w.close(); } catch { /* closed */ } watchers.delete(slug); }
    for (const [slug, root] of want) {
      if (watchers.has(slug) || !fs.existsSync(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true }, (_e, f) => { if (relevant(f)) markDirty(slug); });
        w.on('error', () => { try { w.close(); } catch { /* closed */ } watchers.delete(slug); });
        watchers.set(slug, { root, w });
      } catch { watchers.set(slug, { root, w: { close() {} } }); } // no watcher support: the interval check still saves
    }
  }

  function save(slug, reason) {
    try {
      const r = ss.checkpoint(slug, { reason });
      metrics.lastMs = r.ms;
      if (!r.unchanged) { metrics.checkpoints++; log({ action: 'smartsave.checkpoint', summary: `SmartSave: saved ${slug} (${reason}: ${r.added} new, ${r.changed} changed, ${r.deleted} deleted)`, project: slug }); onChange(); }
      return r;
    } catch (e) {
      if (e.code === 'BUSY') return { busy: true };
      metrics.errors++; metrics.lastError = e.message; return { error: e.message };
    }
  }
  function saveAll(reason) { return Object.fromEntries(ss.enabledProjects().map((s) => [s, save(s, reason)])); }
  let uploading = null;
  function kickUpload() { if (uploading || !ss.state().queue.length) return uploading; uploading = ss.uploadPending({ maxMs: 45000 }).then((r) => { metrics.uploads += r.uploaded || 0; if (r.uploaded || r.failed) onChange(); return r; }).catch((e) => { metrics.lastError = e.message; }).finally(() => { uploading = null; }); return uploading; }

  /** Triggers from agent hooks (written as small files by the hook process: fast, no server round trip). */
  function readTriggers() {
    let names = [];
    try { names = fs.readdirSync(trigDir).filter((n) => n.endsWith('.json')); } catch { return; }
    for (const n of names.slice(0, 50)) {
      const f = path.join(trigDir, n);
      let t = null; try { t = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* partial */ }
      fs.rmSync(f, { force: true });
      if (!t) continue;
      const slug = t.project && ss.enabledProjects().includes(t.project) ? t.project : ss.projectForPath(t.cwd);
      if (!slug) continue;
      if (t.urgent) save(slug, t.reason || 'agent'); else markDirty(slug);
    }
  }

  /** Verified usage signals only (Codex writes its quota percentages; Claude limits come through hooks). */
  function checkUsage(now) {
    if (now - usageCheck < 60000) return;
    usageCheck = now;
    let u; try { u = require('../usage').scan({ now }); } catch { return; }
    const r = usageCrossing(usageBand.codex || 0, u.codex && u.codex.limits, now);
    if (r.save) { saveAll(`usage ${r.band}%`); kickUpload(); }
    if (r.band !== null) usageBand.codex = r.band;
  }

  function tick() {
    const c = conf().smartsave || {};
    if (!c.enabled) return;
    const now = Date.now();
    syncWatchers();
    readTriggers();
    const busy = os.loadavg()[0] > os.cpus().length * 1.5; // heavy load: wait (except the max-latency deadline)
    const deb = (c.debounceSec || 15) * 1000; const max = (c.intervalSec || 120) * 1000;
    for (const slug of ss.enabledProjects()) {
      const first = ss.dirtyAt[slug];
      const st = ss.state().projects[slug];
      const never = !st || !st.last;
      if (never) { save(slug, 'first save'); continue; }
      if (first && ((now - lastEvent[slug] >= deb && !busy) || now - first >= max)) { save(slug, 'files changed'); continue; }
      if (!first && now - Date.parse(st.last.time) >= Math.max(max, 10 * 60000) && !busy) save(slug, 'periodic check'); // catches missed events
    }
    checkUsage(now);
    kickUpload();
    if (now - lastPrune > 24 * 3600e3) { lastPrune = now; try { ss.prune(); } catch { /* busy: tomorrow */ } }
  }
  const timer = setInterval(() => { try { tick(); } catch (e) { metrics.lastError = e.message; } }, 5000);
  timer.unref();
  setTimeout(() => { try { tick(); } catch { /* next tick */ } }, 1500).unref();

  return {
    ss, metrics, save, saveAll, kickUpload, tick,
    /** Before Cortex installs an update: save everything and give uploads a short head start. */
    async beforeUpdate() { if (!(conf().smartsave || {}).enabled) return; saveAll('before update'); try { await Promise.race([kickUpload() || Promise.resolve(), new Promise((r) => setTimeout(r, 20000))]); } catch { /* update anyway */ } },
    stop() { clearInterval(timer); for (const w of watchers.values()) { try { w.w.close(); } catch { /* closed */ } } },
  };
}

/**
 * Did verified usage cross 75% or 90% since last time? Edge-triggered (one save per band, re-armed when usage drops,
 * e.g. after the window resets). Unknown or stale (> 30 min) data → band null: nothing to do, timers keep saving.
 */
function usageCrossing(prevBand, limits, now = Date.now()) {
  if (!limits || !limits.checkedAt || now - Date.parse(limits.checkedAt) > 30 * 60000) return { band: null, save: false, reason: limits ? 'stale' : 'unknown' };
  const pct = Math.max(limits.primary ? limits.primary.usedPercent || 0 : 0, limits.secondary ? limits.secondary.usedPercent || 0 : 0);
  const band = limits.limitReached || pct >= 90 ? 90 : pct >= 75 ? 75 : 0;
  return { band, pct, save: band > prevBand };
}

/** Called from an agent hook process: record a trigger; for urgent moments also save right away (time-boxed). */
function hookTrigger(vault, { reason, cwd, urgent, session }) {
  const settings = require('../settings').load(vault);
  const c = settings.smartsave || {};
  if (!c.enabled) return null;
  const home = path.join(vault, '.cortex', 'smartsave');
  const dir = path.join(home, 'triggers');
  fs.mkdirSync(dir, { recursive: true });
  let saved = null;
  if (urgent) {
    try {
      const { Store } = require('../store');
      const ss = new SmartSave({ home, store: new Store(vault), device: c.device || os.hostname(), config: () => c });
      const slug = ss.projectForPath(cwd);
      if (slug) saved = ss.checkpoint(slug, { reason });
    } catch (e) { saved = { error: e.message }; }
  }
  // the running Cortex uploads it (and saves it, if this process could not)
  fs.writeFileSync(path.join(dir, `${Date.now()}-${process.pid}.json`), JSON.stringify({ reason, cwd, urgent: urgent && !(saved && saved.snapshot), session, at: new Date().toISOString() }));
  return saved;
}

module.exports = { startService, hookTrigger, usageCrossing };
