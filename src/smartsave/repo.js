'use strict';
// SmartSave repository: immutable, content-addressed, compressed and encrypted objects plus snapshot manifests.
// Layout (the same on the local cache and on every backup target):
//   objects/<2 hex>/<64 hex>            gzip(content) encrypted with AES-256-GCM; id = HMAC-SHA256(key, content)
//   snapshots/<workspace>/<id>.json     manifest (encrypted the same way), written only after its objects exist
// Identical content is stored once (across versions, projects and devices). Corruption is detected by the GCM tag
// and by re-checking the id after decryption. Writes are atomic (temp file → fsync → rename).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('CSS1');

function newKey() { return crypto.randomBytes(32); }

class Repo {
  constructor(dir, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('SmartSave repo key must be 32 bytes');
    this.dir = dir; this.key = key;
  }
  idOf(buf) { return crypto.createHmac('sha256', this.key).update(buf).digest('hex'); }
  objPath(id) { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('bad object id'); return path.join(this.dir, 'objects', id.slice(0, 2), id); }
  snapPath(ws, id) {
    if (!/^[\w-]{1,80}$/.test(ws) || !/^[\w-]{1,80}$/.test(id)) throw new Error('bad snapshot name');
    return path.join(this.dir, 'snapshots', ws, id + '.json');
  }

  seal(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(zlib.gzipSync(plain, { level: 6 })), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
  }
  open(sealed) {
    if (!Buffer.isBuffer(sealed) || sealed.length < 32 || !sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not a SmartSave object (corrupted?)');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, sealed.subarray(4, 16));
    d.setAuthTag(sealed.subarray(16, 32));
    let gz;
    try { gz = Buffer.concat([d.update(sealed.subarray(32)), d.final()]); } catch { throw new Error('object failed its integrity check (corrupted, or the wrong recovery key)'); }
    return zlib.gunzipSync(gz);
  }

  /** Store content; returns { id, stored } (stored=false when it already existed: deduplicated). */
  put(buf) {
    const id = this.idOf(buf);
    const f = this.objPath(id);
    if (fs.existsSync(f)) return { id, stored: false, bytes: 0 };
    const sealed = this.seal(buf);
    writeAtomic(f, sealed);
    return { id, stored: true, bytes: sealed.length };
  }
  has(id) { try { return fs.statSync(this.objPath(id)).size > 32; } catch { return false; } }
  readRaw(id) { return fs.readFileSync(this.objPath(id)); }
  writeRaw(id, sealed) { if (!fs.existsSync(this.objPath(id))) writeAtomic(this.objPath(id), sealed); }
  /** Content of an object, verified (decrypts and re-checks the id). */
  get(id) {
    const buf = this.open(this.readRaw(id));
    if (this.idOf(buf) !== id) throw new Error(`object ${id.slice(0, 12)} does not match its id (corrupted)`);
    return buf;
  }

  /** Publish a snapshot. Refuses if any referenced object is missing (never a manifest pointing at nothing). */
  putSnapshot(m) {
    const missing = m.files.filter((f) => !this.has(f.id));
    if (missing.length) throw new Error(`refusing to publish snapshot: ${missing.length} objects missing`);
    const body = Buffer.from(JSON.stringify(m));
    writeAtomic(this.snapPath(m.workspace, m.id), this.seal(body));
    return m;
  }
  getSnapshot(ws, id) { return JSON.parse(this.open(fs.readFileSync(this.snapPath(ws, id))).toString('utf8')); }
  readSnapshotRaw(ws, id) { return fs.readFileSync(this.snapPath(ws, id)); }
  writeSnapshotRaw(ws, id, sealed) { this.open(sealed); writeAtomic(this.snapPath(ws, id), sealed); }
  workspaces() { try { return fs.readdirSync(path.join(this.dir, 'snapshots')).filter((n) => /^[\w-]+$/.test(n)); } catch { return []; } }
  /** Snapshot ids for a workspace, newest first (ids sort by time). */
  snapshotIds(ws) { try { return fs.readdirSync(path.join(this.dir, 'snapshots', ws)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().reverse(); } catch { return []; } }
  listSnapshots(ws, { limit = 50 } = {}) {
    const out = [];
    for (const id of this.snapshotIds(ws).slice(0, limit)) { try { const m = this.getSnapshot(ws, id); out.push(summary(m)); } catch (e) { out.push({ id, workspace: ws, corrupt: true, error: e.message }); } }
    return out;
  }
  objectIds() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(this.dir, 'objects')); } catch { return out; }
    for (const d of dirs) { try { for (const n of fs.readdirSync(path.join(this.dir, 'objects', d))) if (/^[a-f0-9]{64}$/.test(n)) out.push(n); } catch { /* gone */ } }
    return out;
  }

  /** Check a snapshot: every object present, decrypts and matches its id. */
  verifySnapshot(ws, id) {
    const m = this.getSnapshot(ws, id);
    const bad = [];
    for (const f of m.files) { try { this.get(f.id); } catch (e) { bad.push({ path: f.path, error: e.message }); } }
    return { ok: bad.length === 0, files: m.files.length, bad };
  }

  /**
   * Retention: keep the newest `keepLast`, one per hour for `hourly` hours, one per day for `daily` days, one per week
   * for `weekly` weeks, pinned ones, and `protect` ids (e.g. the last verified upload). Then delete objects nothing uses.
   */
  prune(ws, { keepLast = 20, hourly = 48, daily = 30, weekly = 26, protect = [], dryRun = false, now = Date.now() } = {}) {
    const ids = this.snapshotIds(ws);
    const keep = new Set(ids.slice(0, keepLast));
    const seen = { h: new Set(), d: new Set(), w: new Set() };
    for (const id of ids) {
      let m; try { m = this.getSnapshot(ws, id); } catch { keep.add(id); continue; } // never delete what we can't read
      const t = Date.parse(m.time); const age = now - t;
      if (m.pinned || protect.includes(id)) keep.add(id);
      const h = Math.floor(t / 3600e3); const d = Math.floor(t / 864e5); const w = Math.floor(t / (7 * 864e5));
      if (age < hourly * 3600e3 && !seen.h.has(h)) { seen.h.add(h); keep.add(id); }
      if (age < daily * 864e5 && !seen.d.has(d)) { seen.d.add(d); keep.add(id); }
      if (age < weekly * 7 * 864e5 && !seen.w.has(w)) { seen.w.add(w); keep.add(id); }
    }
    const drop = ids.filter((id) => !keep.has(id));
    if (!dryRun) for (const id of drop) fs.rmSync(this.snapPath(ws, id), { force: true });
    return { kept: ids.length - drop.length, dropped: drop };
  }
  /** Delete objects no snapshot (in any workspace) refers to. */
  gc({ dryRun = false } = {}) {
    const used = new Set();
    for (const ws of this.workspaces()) for (const id of this.snapshotIds(ws)) { try { for (const f of this.getSnapshot(ws, id).files) used.add(f.id); } catch { return { skipped: 'a snapshot could not be read; nothing deleted' }; } }
    let freed = 0; let removed = 0;
    for (const id of this.objectIds()) {
      if (used.has(id)) continue;
      const f = this.objPath(id);
      try { freed += fs.statSync(f).size; if (!dryRun) fs.rmSync(f, { force: true }); removed++; } catch { /* gone */ }
    }
    return { removed, freed };
  }
}

function summary(m) {
  return { id: m.id, workspace: m.workspace, time: m.time, reason: m.reason, device: m.device, files: m.files.length, bytes: m.files.reduce((s, f) => s + f.size, 0), changed: m.stats ? m.stats.changed : undefined, deleted: (m.deleted || []).length, git: m.git, context: m.context ? { task: m.context.task, agent: m.context.agent, step: m.context.step } : undefined, pinned: !!m.pinned };
}

function writeAtomic(f, buf) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, f);
}

module.exports = { Repo, newKey, writeAtomic, summary };
