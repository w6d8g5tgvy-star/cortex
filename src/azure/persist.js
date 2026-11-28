'use strict';
// Cosmos DB as Cortex's permanent store on Azure. Cortex keeps working on a local copy of the vault (fast, and every
// module works unchanged); this module makes Cosmos the record:
//   - on start: restore the whole vault (memories, tasks, projects, skills, attachments AND .cortex state such as
//     settings, devices, workflows, chats) from Cosmos into the local copy
//   - while running: upload what changed every few seconds (and right after a change); deletions follow
//   - on shutdown (App Service sends SIGTERM on restart/deploy): a final upload
// Files are split into 512 KB parts; appending to a big file (like the activity log) only rewrites its last part,
// which keeps request units low. One container "vault", partition key /area (top folder).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTAINER = 'vault';
const PART = 512 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const SKIP_TOP = new Set(['.git', 'node_modules', '.update', '.trash-tmp']);
const SKIP_CORTEX = /^\.cortex\/(backups|smartsave|update|screen|tmp)(\/|$)|^\.cortex\/[^/]*\.(lock|pid)$|^\.cortex\/semantic|^\.cortex\/cortex\.log$/;
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const docId = (rel, i) => `${sha(rel).slice(0, 24)}-${i}`;
const areaOf = (rel) => rel.split('/')[0] || '_root';

function skip(rel) {
  if (rel.endsWith('.tmp') || rel.endsWith('.cortex-tmp') || /\.\d+\.tmp$/.test(rel)) return true;
  if (SKIP_TOP.has(rel.split('/')[0])) return true;
  return SKIP_CORTEX.test(rel);
}

/** Every file to keep: { rel: { size, mtimeMs } }. */
function scan(vault) {
  const out = {};
  const walk = (dir, rel) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || skip(r)) continue;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(path.join(dir, e.name)); if (st.size <= MAX_FILE) out[r] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) }; } catch { /* gone */ }
    }
  };
  walk(vault, '');
  return out;
}

const safeRel = (r) => { r = String(r || '').replace(/\\/g, '/'); return r && !r.startsWith('/') && !/^[a-zA-Z]:/.test(r) && !r.split('/').some((s) => s === '..' || s === '') ? r : null; };

/** Restore the vault from Cosmos. Returns the "known" index used to detect later changes. */
async function hydrate(cosmos, vault) {
  fs.mkdirSync(vault, { recursive: true });
  const docs = await cosmos.query(CONTAINER, 'SELECT * FROM c');
  const byPath = new Map();
  for (const d of docs) { if (!d.path) continue; const g = byPath.get(d.path) || []; g.push(d); byPath.set(d.path, g); }
  const known = {}; let files = 0; let broken = 0;
  for (const [rel0, parts] of byPath) {
    const rel = safeRel(rel0); if (!rel || skip(rel)) continue;
    parts.sort((a, b) => a.part - b.part);
    if (parts[0].part !== 0) { broken++; continue; }
    const n = parts[0].parts;
    if (parts.length < n || parts.slice(0, n).some((p, i) => p.part !== i)) { broken++; continue; } // incomplete upload: skip, the local copy (if any) is kept
    const buf = Buffer.concat(parts.slice(0, n).map((p) => Buffer.from(p.data || '', 'base64')));
    if (sha(buf) !== parts[0].hash) { broken++; continue; }
    const dest = path.join(vault, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', buf); fs.renameSync(dest + '.tmp', dest);
    const mt = new Date(parts[0].mtimeMs || Date.now()); try { fs.utimesSync(dest, mt, mt); } catch { /* ok */ }
    const st = fs.statSync(dest);
    known[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), hash: parts[0].hash, partHashes: parts.slice(0, n).map((p) => p.partHash), parts: n };
    files++;
  }
  return { known, files, broken };
}

/** Upload changes since `known` (mutated in place). Returns { uploaded, deleted, charge }. */
async function push(cosmos, vault, known) {
  const now = scan(vault); let uploaded = 0; let deleted = 0; let charge = 0;
  for (const [rel, m] of Object.entries(now)) {
    const k = known[rel];
    if (k && k.size === m.size && k.mtimeMs === m.mtimeMs) continue;
    let buf; try { buf = fs.readFileSync(path.join(vault, ...rel.split('/'))); } catch { continue; }
    const hash = sha(buf);
    if (k && k.hash === hash) { k.mtimeMs = m.mtimeMs; k.size = m.size; continue; } // touched, not changed
    const n = Math.max(1, Math.ceil(buf.length / PART));
    const partHashes = [];
    for (let i = 0; i < n; i++) {
      const chunk = buf.subarray(i * PART, (i + 1) * PART); const ph = sha(chunk); partHashes.push(ph);
      // part 0 carries the file's hash, size and part count (checked on restore), so it's always written; other parts
      // are skipped when unchanged, so appending to a big file rewrites only part 0 and the last part
      if (i > 0 && k && k.partHashes && k.partHashes[i] === ph) continue;
      await cosmos.upsert(CONTAINER, { id: docId(rel, i), area: areaOf(rel), path: rel, part: i, parts: n, partHash: ph, hash, size: buf.length, mtimeMs: m.mtimeMs, data: chunk.toString('base64') }, areaOf(rel));
    }
    for (let i = n; k && i < (k.parts || 0); i++) await cosmos.delete(CONTAINER, docId(rel, i), areaOf(rel)); // file got shorter
    known[rel] = { size: m.size, mtimeMs: m.mtimeMs, hash, partHashes, parts: n };
    uploaded++;
  }
  for (const rel of Object.keys(known)) {
    if (now[rel]) continue;
    for (let i = 0; i < (known[rel].parts || 1); i++) await cosmos.delete(CONTAINER, docId(rel, i), areaOf(rel));
    delete known[rel]; deleted++;
  }
  return { uploaded, deleted, charge };
}

/** Keep Cosmos up to date while Cortex runs. */
function startPersistence({ cosmos, vault, known, store, log = console.log, intervalMs = 5000 }) {
  let busy = null; let dirty = true; let lastError = null; let last = { at: null, uploaded: 0, deleted: 0 };
  const run = async () => {
    if (busy) { dirty = true; return busy; }
    dirty = false;
    busy = push(cosmos, vault, known).then((r) => { last = { at: new Date().toISOString(), ...r }; lastError = null; if (r.uploaded || r.deleted) log(`Saved to Cosmos DB: ${r.uploaded} changed, ${r.deleted} removed`); })
      .catch((e) => { lastError = e.message; log(`Cosmos DB save failed (will retry): ${e.message}`); dirty = true; })
      .finally(() => { busy = null; });
    return busy;
  };
  const timer = setInterval(() => { run(); }, intervalMs); if (timer.unref) timer.unref();
  let soon = null; if (store) store.on('change', () => { clearTimeout(soon); soon = setTimeout(run, 800); if (soon.unref) soon.unref(); });
  return { flush: async () => { await busy; return run(); }, status: () => ({ ...last, error: lastError, files: Object.keys(known).length }), stop: () => clearInterval(timer) };
}

module.exports = { hydrate, push, startPersistence, scan, skip, CONTAINER, PART, docId };
