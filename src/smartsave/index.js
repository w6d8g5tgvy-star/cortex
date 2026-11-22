'use strict';
// Cortex SmartSave: zero-token autosave of real project files plus recovery context, copied to backup targets away
// from this computer, restorable on another computer. See notes "SmartSave: design decisions".
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Repo, newKey, writeAtomic, summary } = require('./repo');
const { scan, secretIn, safeRel } = require('./scan');
const targets = require('./targets');

const DEFAULTS = { enabled: false, debounceSec: 15, intervalSec: 120, maxFileMB: 25, projects: {}, targets: [], retention: { keepLast: 20, hourly: 48, daily: 30, weekly: 26 } };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

class SmartSave {
  /** home: where the local cache/state live (vault/.cortex/smartsave on a Cortex; ~/.cortex-runner/smartsave on a runner). */
  constructor({ home, store = null, device = os.hostname(), config = null, key = null }) {
    this.home = home; this.store = store; this.device = String(device).slice(0, 40);
    this.configFn = typeof config === 'function' ? config : () => config || {};
    fs.mkdirSync(home, { recursive: true });
    this.key = key || this.loadKey();
    this.repo = new Repo(path.join(home, 'repo'), this.key);
    this.uploading = false; this.dirtyAt = {}; this.lastUsageMark = {};
  }
  conf() { const c = this.configFn() || {}; return { ...DEFAULTS, ...c, retention: { ...DEFAULTS.retention, ...(c.retention || {}) }, projects: c.projects || {}, targets: c.targets || [] }; }

  // ---------- key (shown once as the recovery key; needed to restore from a backup target elsewhere) ----------
  loadKey() {
    const f = path.join(this.home, 'key');
    try { const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64url'); if (k.length === 32) return k; } catch { /* first run */ }
    const k = newKey(); writeAtomic(f, Buffer.from(k.toString('base64url'))); try { fs.chmodSync(f, 0o600); } catch { /* windows */ }
    return k;
  }
  recoveryKey() { return 'CSK1-' + this.key.toString('base64url'); }
  static parseRecoveryKey(s) { const m = String(s || '').trim().match(/^CSK1-([A-Za-z0-9_-]{43})$/); if (!m) throw new Error('That is not a SmartSave recovery key (it starts with CSK1-)'); return Buffer.from(m[1], 'base64url'); }

  // ---------- state ----------
  stateFile() { return path.join(this.home, 'state.json'); }
  state() { try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { return { projects: {}, queue: [], targets: {} }; } }
  saveState(s) { writeAtomic(this.stateFile(), Buffer.from(JSON.stringify(s))); }
  secrets() { try { return JSON.parse(fs.readFileSync(path.join(this.home, 'secrets.json'), 'utf8')); } catch { return {}; } }
  setSecret(id, value) { const s = this.secrets(); if (value) s[id] = value; else delete s[id]; writeAtomic(path.join(this.home, 'secrets.json'), Buffer.from(JSON.stringify(s))); try { fs.chmodSync(path.join(this.home, 'secrets.json'), 0o600); } catch { /* windows */ } }

  // ---------- one writer at a time (hooks, server and runner may all try) ----------
  lock(fn) {
    const f = path.join(this.home, 'lock');
    let fd;
    for (let i = 0; i < 2; i++) {
      try { fd = fs.openSync(f, 'wx'); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let age = 0; let pid = 0;
        try { age = Date.now() - fs.statSync(f).mtimeMs; pid = Number(fs.readFileSync(f, 'utf8')) || 0; } catch { /* gone */ }
        let alive = true;
        if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch (err) { alive = err.code === 'EPERM'; } }
        if (age > 120000 || (pid && !alive) || (!pid && age > 5000)) { fs.rmSync(f, { force: true }); continue; } // left by a killed process
        const err = new Error('Another save is in progress'); err.code = 'BUSY'; throw err;
      }
    }
    try { fs.writeSync(fd, String(process.pid)); return fn(); } finally { fs.closeSync(fd); fs.rmSync(f, { force: true }); }
  }

  // ---------- projects ----------
  projectRoot(slug) {
    const pc = this.conf().projects[slug] || {};
    if (pc.root) return pc.root;
    const p = this.store && this.store.get('projects/' + slug);
    return p && p.meta.folder ? p.meta.folder : null;
  }
  enabledProjects() { const c = this.conf(); return c.enabled ? Object.entries(c.projects).filter(([, v]) => v && v.enabled).map(([k]) => k).filter((k) => this.projectRoot(k)) : []; }
  projectForPath(p) { const abs = path.resolve(String(p || '')); return this.enabledProjects().find((s) => { const r = path.resolve(this.projectRoot(s)); return abs === r || abs.startsWith(r + path.sep); }) || null; }

  /** Concise recovery context from Cortex's own records (tasks, sessions, journal). Never calls an AI. */
  context(slug) {
    if (!this.store) return {};
    try {
      const st = this.store;
      const tasks = st.list('task', { project: slug, open: true, limit: 50 });
      const doing = tasks.filter((t) => t.meta.status === 'doing' || t.meta.status === 'blocked');
      const sess = require('../sessions').list(st.vault).filter((s) => s.project === slug).sort((a, b) => (a.updated < b.updated ? 1 : -1))[0];
      const journal = st.list('note', { project: slug }).find((r) => r.meta.agent_journal);
      const lastOutcome = journal ? (String(journal.body).match(/\*\*Outcome:\*\*([^\n]+)/g) || []).slice(-1)[0] : null;
      return {
        task: doing[0] ? { id: doing[0].id, title: doing[0].title, status: doing[0].meta.status } : undefined,
        open_tasks: tasks.slice(0, 8).map((t) => `[${t.meta.status}] ${t.title} (${t.id})`),
        agent: sess ? sess.agent : undefined, model: sess ? sess.model : undefined, session: sess ? sess.id : undefined,
        step: sess ? clip(sess.step, 200) : undefined, asked: sess ? clip(sess.turnPrompt || sess.prompt || sess.title, 400) : undefined,
        files_touched: sess ? (sess.files || []).slice(-20) : undefined,
        last_outcome: lastOutcome ? clip(lastOutcome.replace(/\*\*Outcome:\*\*/, ''), 500) : undefined,
        blockers: doing.filter((t) => t.meta.status === 'blocked').map((t) => t.title).slice(0, 5),
      };
    } catch { return {}; }
  }

  /** Read-only git info (never runs git, never touches the index). */
  static gitInfo(root) {
    try {
      const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
      const m = head.match(/^ref: refs\/heads\/(.+)$/);
      if (!m) return { detached: head.slice(0, 40) };
      let commit = null;
      try { commit = fs.readFileSync(path.join(root, '.git', 'refs', 'heads', m[1]), 'utf8').trim().slice(0, 40); } catch { /* packed ref */ }
      return { branch: m[1], head: commit };
    } catch { return null; }
  }

  /**
   * Save a checkpoint of a project: changed files go into the local repository (deduplicated, compressed,
   * encrypted), then a snapshot is published and queued for every backup target. Returns a summary.
   */
  checkpoint(slug, { reason = 'auto', force = false, root = null, context = null } = {}) {
    root = root || this.projectRoot(slug);
    if (!root || !fs.existsSync(root)) throw new Error(`No folder for project "${slug}"`);
    if (!/^[\w-]{1,80}$/.test(slug)) throw new Error('bad project id');
    return this.lock(() => {
      const t0 = Date.now();
      const s = this.state();
      const ps = s.projects[slug] || (s.projects[slug] = { index: {} });
      const pc = this.conf().projects[slug] || {};
      const res = scan(root, { prev: ps.index, exclude: pc.exclude || [], include: pc.include || [], maxFileMB: this.conf().maxFileMB });
      let changed = 0; let added = 0; let newBytes = 0; const blocked = [];
      const files = [];
      for (const f of res.files) {
        if (f.id) { files.push(f); continue; }
        let buf;
        try { buf = fs.readFileSync(path.join(root, f.path)); } catch (e) {
          const prev = ps.index[f.path];
          if (prev && prev.id) files.push({ ...prev, path: f.path, stale: true }); // locked right now: keep the last good copy
          res.skipped.push({ path: f.path, reason: `locked or unreadable (${e.code}); kept the previous version` });
          continue;
        }
        const secret = secretIn(buf);
        if (secret) { blocked.push({ path: f.path, reason: `contains ${secret}` }); continue; }
        const r = this.repo.put(buf);
        if (ps.index[f.path]) changed++; else added++;
        newBytes += r.bytes;
        files.push({ ...f, id: r.id, size: buf.length });
      }
      const present = new Set(files.map((f) => f.path));
      const deleted = Object.keys(ps.index).filter((p) => !present.has(p) && !res.skipped.some((x) => x.path === p) && !blocked.some((x) => x.path === p));
      if (!force && !changed && !added && !deleted.length && ps.last) return { unchanged: true, snapshot: ps.last.id, ms: Date.now() - t0 };
      const id = Date.now().toString(36).padStart(9, '0') + '-' + crypto.randomBytes(3).toString('hex');
      const m = {
        v: 1, id, workspace: slug, project: slug, rootName: path.basename(root), device: this.device, parent: ps.last ? ps.last.id : null,
        time: new Date().toISOString(), reason, files: files.map(({ path: p, id: fid, size, mode, mtimeMs }) => ({ path: p, id: fid, size, mode, mtimeMs })),
        deleted, stats: { changed, added, deleted: deleted.length, newBytes, skipped: res.skipped.length + blocked.length },
        skipped: [...blocked, ...res.skipped].slice(0, 200), git: SmartSave.gitInfo(root), context: context || this.context(slug),
      };
      this.repo.putSnapshot(m);
      ps.index = Object.fromEntries(files.map((f) => [f.path, { size: f.size, mtimeMs: f.mtimeMs, id: f.id }]));
      ps.last = { id, time: m.time, reason, files: files.length };
      ps.count = (ps.count || 0) + 1;
      for (const t of this.conf().targets) if (!s.queue.some((q) => q.target === t.id && q.ws === slug && q.id === id)) s.queue.push({ target: t.id, ws: slug, id, added: m.time });
      this.saveState(s);
      delete this.dirtyAt[slug];
      return { snapshot: id, files: files.length, changed, added, deleted: deleted.length, newBytes, skipped: m.stats.skipped, blocked, ms: Date.now() - t0 };
    });
  }

  /** What would be saved (for the privacy preview): included files and skipped files with reasons. */
  preview(slug) {
    const root = this.projectRoot(slug);
    if (!root) throw new Error('This project has no folder yet');
    const pc = this.conf().projects[slug] || {};
    const r = scan(root, { exclude: pc.exclude || [], include: pc.include || [], maxFileMB: this.conf().maxFileMB });
    const flagged = [];
    for (const f of r.files) { try { const b = fs.readFileSync(path.join(root, f.path)); const s = secretIn(b); if (s) flagged.push({ path: f.path, reason: `contains ${s}` }); } catch { /* skip */ } }
    const flaggedSet = new Set(flagged.map((x) => x.path));
    const inc = r.files.filter((f) => !flaggedSet.has(f.path));
    return { root, included: inc.length, bytes: inc.reduce((n, f) => n + f.size, 0), sample: inc.slice(0, 40).map((f) => f.path), skipped: [...flagged, ...r.skipped].slice(0, 200), skippedCount: flagged.length + r.skipped.length };
  }

  // ---------- uploads (asynchronous, retried, verified) ----------
  target(id) { const t = this.conf().targets.find((x) => x.id === id); if (!t) throw new Error('Unknown backup target'); return targets.make(t, this.secrets()); }

  /** Upload queued snapshots. Objects first (skipping ones the target has), the snapshot last, then read it back. */
  async uploadPending({ maxMs = 60000, now = Date.now() } = {}) {
    if (this.uploading) return { busy: true };
    this.uploading = true;
    const t0 = Date.now(); let done = 0; let failed = 0;
    try {
      let s = this.state();
      for (const q of [...s.queue]) {
        if (Date.now() - t0 > maxMs) break;
        const ts = s.targets[q.target] || (s.targets[q.target] = {});
        if (ts.nextTry && ts.nextTry > now) continue; // backing off after a failure
        if (!this.conf().targets.some((t) => t.id === q.target)) { s.queue = s.queue.filter((x) => x !== q); continue; }
        try {
          const tg = this.target(q.target);
          const m = this.repo.getSnapshot(q.ws, q.id);
          let sent = 0;
          for (const f of m.files) {
            const k = `objects/${f.id.slice(0, 2)}/${f.id}`;
            if (await tg.has(k)) continue;
            await tg.put(k, this.repo.readRaw(f.id)); sent += f.size;
          }
          const sk = `snapshots/${q.ws}/${q.id}.json`;
          const raw = this.repo.readSnapshotRaw(q.ws, q.id);
          await tg.put(sk, raw);
          // verify: the snapshot reads back intact and every object it needs is there
          const back = await tg.get(sk);
          if (!back.equals(raw)) throw new Error('verification failed: the uploaded snapshot does not match');
          for (const f of m.files) if (!(await tg.has(`objects/${f.id.slice(0, 2)}/${f.id}`))) throw new Error('verification failed: an uploaded file is missing');
          s = this.state(); // re-read: a checkpoint may have run meanwhile
          s.queue = s.queue.filter((x) => !(x.target === q.target && x.ws === q.ws && x.id === q.id));
          const t2 = s.targets[q.target] || (s.targets[q.target] = {});
          Object.assign(t2, { lastVerified: new Date().toISOString(), lastError: null, failures: 0, nextTry: null, bytesSent: (t2.bytesSent || 0) + sent });
          t2.verified = t2.verified || {}; t2.verified[q.ws] = { id: q.id, time: m.time };
          this.saveState(s); done++;
        } catch (e) {
          s = this.state();
          const t2 = s.targets[q.target] || (s.targets[q.target] = {});
          t2.failures = (t2.failures || 0) + 1;
          t2.lastError = clip(e.message, 300); t2.lastErrorAt = new Date().toISOString();
          t2.nextTry = Date.now() + Math.min(30 * 60000, 15000 * 2 ** Math.min(t2.failures - 1, 7)); // 15 s … 30 min
          this.saveState(s); failed++;
        }
      }
    } finally { this.uploading = false; }
    return { uploaded: done, failed };
  }

  /** Mark snapshots as safely copied by a paired computer that pulled them (replication). */
  ackReplica(targetId, items) {
    const s = this.state();
    const t = s.targets[targetId] || (s.targets[targetId] = {});
    t.verified = t.verified || {};
    for (const it of items || []) { let m; try { m = this.repo.getSnapshot(it.ws, it.id); } catch { continue; } const cur = t.verified[it.ws]; if (!cur || cur.time < m.time) t.verified[it.ws] = { id: it.id, time: m.time }; }
    t.lastVerified = new Date().toISOString(); t.lastError = null;
    this.saveState(s);
  }

  // ---------- status ----------
  status() {
    const c = this.conf(); const s = this.state(); const now = Date.now();
    const projects = {};
    const names = new Set([...Object.keys(c.projects).filter((k) => c.projects[k] && c.projects[k].enabled), ...Object.keys(s.projects)]);
    for (const slug of names) {
      const ps = s.projects[slug] || {};
      const per = c.targets.map((t) => {
        const ts = s.targets[t.id] || {};
        const v = ts.verified && ts.verified[slug];
        const queued = s.queue.filter((q) => q.target === t.id && q.ws === slug).length;
        const upToDate = v && ps.last && v.id === ps.last.id;
        const state = ts.lastError && queued ? 'failed' : upToDate ? 'verified' : queued ? 'queued' : v ? 'stale' : 'not-yet';
        return { id: t.id, name: t.name || t.type, type: t.type, state, lastVerified: v ? v.time : null, queued, error: ts.lastError || null, nextTry: ts.nextTry ? new Date(ts.nextTry).toISOString() : null };
      });
      const replicas = Object.entries(s.targets).filter(([id]) => id.startsWith('paired:')).map(([id, ts]) => {
        const v = ts.verified && ts.verified[slug];
        return { id, name: id.slice(7), type: 'paired', state: v && ps.last && v.id === ps.last.id ? 'verified' : v ? 'stale' : 'not-yet', lastVerified: v ? v.time : null, queued: 0, error: null };
      });
      const all = [...per, ...replicas];
      const protectedAt = all.map((x) => x.lastVerified).filter(Boolean).sort().pop() || null;
      projects[slug] = {
        enabled: !!(c.enabled && c.projects[slug] && c.projects[slug].enabled), root: this.projectRoot(slug), snapshots: ps.count || 0,
        lastLocal: ps.last || null, dirty: !!this.dirtyAt[slug], targets: all,
        lastProtected: protectedAt, protection: !c.targets.length && !replicas.length ? 'local-only' : all.some((x) => x.state === 'verified') ? 'protected' : all.some((x) => x.state === 'failed') ? 'failing' : 'pending',
      };
    }
    return { enabled: c.enabled, device: this.device, debounceSec: c.debounceSec, intervalSec: c.intervalSec, projects, targets: c.targets.map((t) => ({ id: t.id, name: t.name || t.type, type: t.type, ...(s.targets[t.id] ? { lastVerified: s.targets[t.id].lastVerified, error: s.targets[t.id].lastError, bytesSent: s.targets[t.id].bytesSent } : {}) })), queue: s.queue.length, checkedAt: new Date(now).toISOString() };
  }
  snapshots(slug, opts) { return this.repo.listSnapshots(slug, opts); }

  // ---------- restore ----------
  /** Fetch a snapshot (and the objects it needs) from a backup target into the local repository. */
  async fetchFrom(targetOrId, ws, id) {
    const tg = typeof targetOrId === 'string' ? this.target(targetOrId) : targetOrId;
    const raw = await tg.get(`snapshots/${ws}/${id}.json`);
    this.repo.writeSnapshotRaw(ws, id, raw);
    const m = this.repo.getSnapshot(ws, id);
    let fetched = 0;
    for (const f of m.files) { if (this.repo.has(f.id)) continue; this.repo.writeRaw(f.id, await tg.get(`objects/${f.id.slice(0, 2)}/${f.id}`)); fetched++; }
    return { files: m.files.length, fetched };
  }
  async remoteSnapshots(targetId, ws) {
    const tg = this.target(targetId);
    const keys = await tg.list(`snapshots/${ws}/`);
    return keys.map((k) => k.split('/').pop().replace(/\.json$/, '')).filter((x) => /^[\w-]+$/.test(x)).sort().reverse();
  }

  /** Compare a snapshot with a folder: which files would be added, changed, unchanged (and which exist only there). */
  diff(ws, id, dest) {
    const m = this.repo.getSnapshot(ws, id);
    const out = { add: [], change: [], same: [], extra: [] };
    const want = new Set();
    for (const f of m.files) {
      if (!safeRel(f.path)) continue;
      want.add(f.path);
      const p = path.join(dest, f.path);
      let cur = null; try { cur = fs.readFileSync(p); } catch { /* missing */ }
      if (!cur) out.add.push(f.path); else if (this.repo.idOf(cur) === f.id) out.same.push(f.path); else out.change.push(f.path);
    }
    if (fs.existsSync(dest)) { try { for (const f of scan(dest).files) if (!want.has(f.path)) out.extra.push(f.path); } catch { /* ignore */ } }
    return { snapshot: summary(m), ...out };
  }

  /**
   * Restore a snapshot into `dest` (default: a NEW folder next to the project). Existing different files are never
   * overwritten unless `overwrite` is true: they are reported as conflicts. Every written file is re-checked.
   */
  restore(ws, id, { dest, overwrite = false } = {}) {
    const m = this.repo.getSnapshot(ws, id);
    if (!dest) throw new Error('Choose where to restore');
    dest = path.resolve(dest);
    fs.mkdirSync(dest, { recursive: true });
    const res = { dest, written: 0, same: 0, conflicts: [], failed: [], verified: 0, context: m.context, git: m.git, time: m.time };
    for (const f of m.files) {
      if (!safeRel(f.path)) { res.failed.push({ path: f.path, error: 'unsafe path' }); continue; }
      const p = path.join(dest, f.path);
      if (!path.resolve(p).startsWith(dest + path.sep)) { res.failed.push({ path: f.path, error: 'outside the restore folder' }); continue; }
      let buf;
      try { buf = this.repo.get(f.id); } catch (e) { res.failed.push({ path: f.path, error: e.message }); continue; }
      let cur = null; try { cur = fs.readFileSync(p); } catch { /* missing */ }
      if (cur && this.repo.idOf(cur) === f.id) { res.same++; res.verified++; continue; }
      if (cur && !overwrite) { res.conflicts.push(f.path); continue; }
      try { fs.lstatSync(p).isSymbolicLink() && fs.rmSync(p); } catch { /* not there */ }
      writeAtomic(p, buf);
      try { fs.chmodSync(p, f.mode || 0o644); } catch { /* windows */ }
      if (this.repo.idOf(fs.readFileSync(p)) === f.id) res.verified++; else res.failed.push({ path: f.path, error: 'written file did not match' });
      res.written++;
    }
    const notes = ['# Restored by Cortex SmartSave', '', `Project: ${ws} · snapshot ${id} · saved ${m.time} on ${m.device} (${m.reason})`, m.git && m.git.branch ? `Git: branch ${m.git.branch}${m.git.head ? ' at ' + m.git.head.slice(0, 10) : ''} (files restored as they were on disk, including uncommitted changes)` : '', '', '## Where the work was', ...Object.entries(m.context || {}).filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) => `- **${k.replace(/_/g, ' ')}:** ${Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : v}`)];
    try { if (!fs.existsSync(path.join(dest, 'CORTEX-RESTORE.md'))) fs.writeFileSync(path.join(dest, 'CORTEX-RESTORE.md'), notes.filter((x) => x !== '').join('\n') + '\n'); } catch { /* optional */ }
    return res;
  }

  /** Retention + garbage collection. Never deletes the newest verified copy of any target. */
  prune({ dryRun = false } = {}) {
    return this.lock(() => {
      const s = this.state(); const out = {};
      const protect = Object.values(s.targets).flatMap((t) => Object.values(t.verified || {}).map((v) => v.id));
      const queued = s.queue.map((q) => q.id);
      for (const ws of this.repo.workspaces()) out[ws] = this.repo.prune(ws, { ...this.conf().retention, protect: [...protect, ...queued, ...Object.values(s.projects).map((p) => p.last && p.last.id).filter(Boolean)], dryRun });
      out.gc = this.repo.gc({ dryRun });
      return out;
    });
  }
}

module.exports = { SmartSave, DEFAULTS };
