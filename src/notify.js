'use strict';
// Notifications (2.2 #23): one place for things that need the user's attention. Related events within 15 minutes
// are grouped (count++) instead of piling up; each kind can be turned off; the browser (and an installed PWA) can
// show them as system notifications.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = { approval: 'Needs your approval', done: 'Finished', failed: 'Failed', qa: 'Quality check', usage: 'Usage limit', backup: 'Backup problem', research: 'Research finding', agent: 'Agent availability' };
const GROUP_MS = 15 * 60 * 1000;
const file = (vault) => path.join(vault, '.cortex', 'notifications.json');
const load = (vault) => { try { return JSON.parse(fs.readFileSync(file(vault), 'utf8')); } catch { return []; } };
const save = (vault, all) => { fs.mkdirSync(path.dirname(file(vault)), { recursive: true }); const t = file(vault) + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(all.slice(-300))); fs.renameSync(t, file(vault)); };

/** Add a notification (or bump a matching unread one). `key` decides what counts as "the same thing". */
function add(vault, { kind, title, body = '', ref = null, project = null, key = null }, settings = null) {
  if (!KINDS[kind]) throw new Error('unknown notification kind');
  const off = ((settings || require('./settings').load(vault)).notifications || {}).off || [];
  if (off.includes(kind)) return null;
  const all = load(vault);
  const k = key || `${kind}|${ref || title}`;
  const now = Date.now();
  const same = all.find((n) => n.key === k && !n.read && now - Date.parse(n.updated) < GROUP_MS);
  if (same) { same.count++; same.updated = new Date(now).toISOString(); same.body = String(body).slice(0, 300) || same.body; save(vault, all); return same; }
  const n = { id: 'n-' + crypto.randomBytes(4).toString('hex'), key: k, kind, label: KINDS[kind], title: String(title).slice(0, 140), body: String(body).slice(0, 300), ref, project, count: 1, read: false, created: new Date(now).toISOString(), updated: new Date(now).toISOString() };
  all.push(n); save(vault, all); return n;
}
function list(vault, { unread = false, limit = 50 } = {}) { const all = load(vault).sort((a, b) => (a.updated < b.updated ? 1 : -1)); return (unread ? all.filter((n) => !n.read) : all).slice(0, limit); }
function markRead(vault, ids) { const all = load(vault); for (const n of all) if (ids === 'all' || (ids || []).includes(n.id)) n.read = true; save(vault, all); return { unread: all.filter((n) => !n.read).length }; }

module.exports = { add, list, markRead, KINDS };
