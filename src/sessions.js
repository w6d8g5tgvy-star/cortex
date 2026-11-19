'use strict';
// Live agent sessions: what each agent is doing right now, plus snapshots and messages from the user.
// Stored as small files in <vault>/.cortex/sessions so separate processes (stdio MCP servers,
// Claude Code hooks, the dashboard) can all read and write them without a running server.
//   <id>.json        session state (written by the agent side)
//   <id>.inbox.jsonl messages from the user (append-only, written by the dashboard)
//   <id>.snap.<ext>  latest snapshot image
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_EVENTS = 80;
const ARCHIVE_DAYS = 30;
const dirOf = (vault) => path.join(vault, '.cortex', 'sessions');
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 80);
const now = () => new Date().toISOString();

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeAtomic(f, data) {
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, f);
}

function get(vault, id) {
  id = safeId(id);
  return id ? readJson(path.join(dirOf(vault), id + '.json'), null) : null;
}

function upsert(vault, id, patch = {}, event) {
  id = safeId(id);
  if (!id) throw new Error('invalid session id');
  const dir = dirOf(vault);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, id + '.json');
  const cur = readJson(f, null) || { id, agent: 'agent', title: '', status: 'working', step: '', progress: null, started: now(), events: [], delivered: 0 };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) cur[k] = v;
  if (event && event.text) {
    cur.events.push({ ts: now(), kind: event.kind || 'step', text: String(event.text).slice(0, 600) });
    if (cur.events.length > MAX_EVENTS) cur.events = cur.events.slice(-MAX_EVENTS);
  }
  cur.updated = now();
  writeAtomic(f, JSON.stringify(cur));
  return cur;
}

function list(vault) {
  const dir = dirOf(vault);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^[A-Za-z0-9_\-]+\.json$/.test(f)); } catch { return []; }
  const cutoff = Date.now() - ARCHIVE_DAYS * 864e5;
  const out = [];
  for (const f of files) {
    const s = readJson(path.join(dir, f), null);
    if (!s) continue;
    if (!s.archived && new Date(s.updated).getTime() < cutoff) s.archived = true; // shown under Archived, never deleted automatically
    s.unread = inbox(vault, s.id).length - (s.delivered || 0);
    out.push(s);
  }
  const rank = { 'needs-you': 0, working: 1, waiting: 2, done: 3, error: 3 };
  return out.sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || (a.updated < b.updated ? 1 : -1));
}

function remove(vault, id) {
  id = safeId(id);
  const dir = dirOf(vault);
  for (const f of fs.readdirSync(dir)) if (f === id + '.json' || f.startsWith(id + '.inbox') || f.startsWith(id + '.snap.')) fs.rmSync(path.join(dir, f), { force: true });
}

// ----- snapshots -----
function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function setSnapshot(vault, id, buf, caption) {
  id = safeId(id);
  const mime = sniffMime(buf);
  if (!mime) throw new Error('Snapshot must be a PNG, JPEG, WebP or GIF image');
  if (buf.length > 12 * 1024 * 1024) throw new Error('Snapshot too large (max 12 MB)');
  const dir = dirOf(vault);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith(id + '.snap.')) fs.rmSync(path.join(dir, f), { force: true });
  writeAtomic(path.join(dir, `${id}.snap.${EXT[mime]}`), buf);
  return upsert(vault, id, { snapshot: { ts: now(), mime, ext: EXT[mime], caption: caption ? String(caption).slice(0, 300) : '' } }, { kind: 'snapshot', text: caption ? `📸 ${caption}` : '📸 Shared a snapshot' });
}

function snapshotFile(vault, id) {
  const s = get(vault, id);
  if (!s || !s.snapshot) return null;
  return { file: path.join(dirOf(vault), `${safeId(id)}.snap.${s.snapshot.ext}`), mime: s.snapshot.mime };
}

// ----- messages from the user (phone/dashboard → agent) -----
function inbox(vault, id) {
  const f = path.join(dirOf(vault), safeId(id) + '.inbox.jsonl');
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function sendMessage(vault, id, text, from = 'you') {
  id = safeId(id);
  if (!get(vault, id)) throw new Error('Session not found');
  const msg = { ts: now(), from, text: String(text).slice(0, 4000) };
  fs.appendFileSync(path.join(dirOf(vault), id + '.inbox.jsonl'), JSON.stringify(msg) + '\n');
  return msg;
}

/** Return unread messages for a session and mark them delivered (called from the agent side). */
function takeMessages(vault, id) {
  const s = get(vault, id);
  if (!s) return [];
  const all = inbox(vault, id);
  const fresh = all.slice(s.delivered || 0);
  if (fresh.length) upsert(vault, id, { delivered: all.length }, { kind: 'delivered', text: `Received ${fresh.length} message${fresh.length > 1 ? 's' : ''} from you` });
  return fresh;
}

function dirStamp(vault) {
  try { return fs.statSync(dirOf(vault)).mtimeMs; } catch { return 0; }
}

module.exports = { get, upsert, list, remove, setSnapshot, snapshotFile, inbox, sendMessage, takeMessages, safeId, dirStamp, sniffMime };
