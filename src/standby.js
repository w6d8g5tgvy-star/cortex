'use strict';
// Standby host (2.2): a paired computer keeps an up-to-date copy of the main Cortex's vault, serves it while the main
// computer is off, and hands its changes back when the main computer returns. Only one copy is active at a time.
// Copied: memories, tasks, projects, skills, Mind, attachments, Fetcher reports and the activity log.
// Never copied: .cortex/ settings, keys, tokens, device pairings, SmartSave keys (each computer keeps its own).
// Conflicts: if the same file changed in both places, both versions are kept (yours next to it as "…from <device>").
const fs = require('fs');
const path = require('path');

const SKIP_TOP = new Set(['.cortex', '.git', '.obsidian', '.trash', 'node_modules']);
const ALLOW_CORTEX = new Set(['.cortex/activity.jsonl']);
const MAX_FILE = 20 * 1024 * 1024;

function safe(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.split('/').some((s) => s === '..' || s === '')) return null;
  const top = r.split('/')[0];
  if (SKIP_TOP.has(top) && !ALLOW_CORTEX.has(r)) return null;
  return r;
}

/** Every syncable file in a vault: { path: { size, mtimeMs } }. */
function index(vault) {
  const out = {};
  const walk = (dir, rel) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!rel && SKIP_TOP.has(e.name)) continue; walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || e.name.endsWith('.tmp')) continue;
      try { const st = fs.statSync(path.join(dir, e.name)); if (st.size <= MAX_FILE) out[r] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) }; } catch { /* gone */ }
    }
  };
  walk(vault, '');
  for (const r of ALLOW_CORTEX) { try { const st = fs.statSync(path.join(vault, r)); out[r] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) }; } catch { /* none */ } }
  return out;
}

/** Main computer: files changed since `known` (the copy's index), plus the full list for deletions. Chunked. */
function changes(vault, known = {}, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const idx = index(vault); const files = []; let bytes = 0; let more = false;
  for (const [r, m] of Object.entries(idx)) {
    const k = known[r];
    if (k && k.size === m.size && Math.abs(k.mtimeMs - m.mtimeMs) <= 2) continue; // file-system timestamp rounding
    if (bytes + m.size > maxBytes && files.length) { more = true; break; }
    files.push({ path: r, mtimeMs: m.mtimeMs, data: fs.readFileSync(path.join(vault, r)).toString('base64') });
    bytes += m.size;
  }
  return { files, all: Object.keys(idx), more, at: Date.now() };
}

/** Copy: write what the main computer sent; remove files the main computer no longer has. */
function applyChanges(vault, resp) {
  let wrote = 0; let removed = 0;
  for (const f of resp.files || []) {
    const r = safe(f.path); if (!r) continue;
    const dest = path.join(vault, ...r.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', Buffer.from(f.data, 'base64')); fs.renameSync(dest + '.tmp', dest);
    try { fs.utimesSync(dest, new Date(), new Date(f.mtimeMs)); } catch { /* ok */ }
    wrote++;
  }
  if (!resp.more && Array.isArray(resp.all)) {
    const keep = new Set(resp.all);
    for (const r of Object.keys(index(vault))) if (!keep.has(r) && !ALLOW_CORTEX.has(r)) { fs.rmSync(path.join(vault, ...r.split('/')), { force: true }); removed++; }
  }
  return { wrote, removed };
}

/**
 * Main computer: take back what changed on the copy while it was active. `baseline` = the main's index at the last
 * sync before the takeover; a file the main ALSO changed since then is a conflict → the copy's version is saved next
 * to it instead of overwriting.
 */
function importChanges(vault, files, { baseline = {}, device = 'standby' } = {}) {
  const now = index(vault); const out = { written: [], conflicts: [] };
  for (const f of files || []) {
    const r = safe(f.path); if (!r || ALLOW_CORTEX.has(r)) continue;
    const dest = path.join(vault, ...r.split('/'));
    const data = Buffer.from(f.data, 'base64');
    const cur = now[r]; const base = baseline[r];
    const mainChanged = cur && (!base || Math.abs(cur.mtimeMs - base.mtimeMs) > 2 || cur.size !== base.size);
    if (mainChanged && !fs.readFileSync(dest).equals(data)) {
      const ext = path.extname(r); const alt = r.slice(0, r.length - ext.length) + ` (from ${String(device).replace(/[^\w -]/g, '').slice(0, 30)})` + ext;
      const altDest = path.join(vault, ...alt.split('/'));
      fs.mkdirSync(path.dirname(altDest), { recursive: true }); fs.writeFileSync(altDest, data); out.conflicts.push({ path: r, savedAs: alt });
    } else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest + '.tmp', data); fs.renameSync(dest + '.tmp', dest); out.written.push(r); }
  }
  return out;
}

/** Copy: files changed locally since the takeover (what to hand back). */
function changedSince(vault, sinceMs) {
  return Object.entries(index(vault)).filter(([r, m]) => m.mtimeMs > sinceMs && !ALLOW_CORTEX.has(r)).map(([r, m]) => ({ path: r, mtimeMs: m.mtimeMs, data: fs.readFileSync(path.join(vault, ...r.split('/'))).toString('base64') }));
}

module.exports = { index, changes, applyChanges, importChanges, changedSince, safe };
