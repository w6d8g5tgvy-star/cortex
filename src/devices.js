'use strict';
// Paired devices: phones (use the dashboard) and computers (run agent jobs for this Cortex).
// Each device gets its own key, so one lost phone can be removed without unpairing the rest.
// Pairing uses a short single-use code that expires in 10 minutes; keys are stored only as hashes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const ONLINE_MS = 2 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const file = (vault) => path.join(vault, '.cortex', 'devices.json');

function load(vault) {
  try { const d = JSON.parse(fs.readFileSync(file(vault), 'utf8')); return { devices: d.devices || [], codes: d.codes || [], failures: d.failures || [] }; } catch { return { devices: [], codes: [], failures: [] }; }
}
function save(vault, d) {
  fs.mkdirSync(path.dirname(file(vault)), { recursive: true });
  const tmp = file(vault) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, file(vault));
}
const cleanName = (s, kind) => String(s || '').replace(/[^\p{L}\p{N} '’._-]/gu, '').trim().slice(0, 40) || (kind === 'computer' ? 'Computer' : 'Phone');
const publicView = (x) => ({ id: x.id, name: x.name, kind: x.kind, created: x.created, lastSeen: x.lastSeen, online: !!x.lastSeen && Date.now() - Date.parse(x.lastSeen) < ONLINE_MS, platform: x.platform, version: x.version, revoked: !!x.revoked });

/** Start pairing a new device. Returns the code to show (only shown once). */
function createCode(vault, { kind = 'phone', name } = {}) {
  if (!['phone', 'computer'].includes(kind)) throw new Error('kind must be phone or computer');
  const d = load(vault);
  const now = Date.now();
  d.codes = d.codes.filter((c) => c.expires > now && !c.used);
  if (d.codes.length >= 5) throw new Error('Too many open pairing codes. Wait a few minutes or use one of them.');
  let code = '';
  for (const b of crypto.randomBytes(8)) code += ALPHABET[b % ALPHABET.length];
  code = code.slice(0, 4) + '-' + code.slice(4);
  d.codes.push({ hash: sha(code), kind, name: cleanName(name, kind), expires: now + CODE_TTL_MS });
  save(vault, d);
  return { code, kind, expiresAt: new Date(now + CODE_TTL_MS).toISOString(), minutes: CODE_TTL_MS / 60000 };
}

/** Exchange a pairing code for a device key. Throws on a wrong, used or expired code (and limits guessing). */
function redeem(vault, code, { name, platform, version, ip } = {}) {
  const d = load(vault);
  const now = Date.now();
  d.failures = d.failures.filter((f) => now - f.t < CODE_TTL_MS);
  if (d.failures.filter((f) => f.ip === (ip || '?')).length >= 10) { save(vault, d); throw new Error('Too many wrong codes. Wait 10 minutes and make a new code.'); }
  const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const want = norm.length === 8 ? sha(norm.slice(0, 4) + '-' + norm.slice(4)) : '';
  const c = d.codes.find((x) => x.hash === want);
  if (!c || c.used || c.expires <= now) {
    d.failures.push({ ip: ip || '?', t: now });
    save(vault, d);
    throw new Error(c && c.used ? 'That code was already used. Make a new one.' : c ? 'That code has expired. Make a new one (codes last 10 minutes).' : 'Wrong pairing code.');
  }
  c.used = true;
  const token = crypto.randomBytes(32).toString('base64url');
  const dev = { id: 'dev-' + crypto.randomBytes(5).toString('hex'), name: cleanName(name || c.name, c.kind), kind: c.kind, tokenHash: sha(token), created: new Date().toISOString(), lastSeen: new Date().toISOString(), platform: String(platform || '').slice(0, 40) || undefined, version: String(version || '').slice(0, 20) || undefined };
  d.devices.push(dev);
  d.codes = d.codes.filter((x) => !x.used && x.expires > now);
  save(vault, d);
  return { device: publicView(dev), token };
}

const seenCache = new Map(); // throttle lastSeen writes
/** The device a key belongs to (or null). Updates "last seen" at most every 30 s. */
function authenticate(vault, token, info = {}) {
  if (!token || String(token).length < 20) return null;
  const h = sha(token);
  const d = load(vault);
  const dev = d.devices.find((x) => x.tokenHash === h && !x.revoked);
  if (!dev) return null;
  const last = seenCache.get(dev.id) || 0;
  if (Date.now() - last > 30000) {
    seenCache.set(dev.id, Date.now());
    dev.lastSeen = new Date().toISOString();
    if (info.platform) dev.platform = String(info.platform).slice(0, 40);
    if (info.version) dev.version = String(info.version).slice(0, 20);
    save(vault, d);
  }
  return publicView(dev);
}

function list(vault) { return load(vault).devices.filter((x) => !x.revoked).map(publicView); }
function rename(vault, id, name) { const d = load(vault); const x = d.devices.find((y) => y.id === id && !y.revoked); if (!x) throw new Error('Device not found'); x.name = cleanName(name, x.kind); save(vault, d); return publicView(x); }
function revoke(vault, id) { const d = load(vault); const x = d.devices.find((y) => y.id === id && !y.revoked); if (!x) throw new Error('Device not found'); x.revoked = true; x.revokedAt = new Date().toISOString(); save(vault, d); return publicView(x); }

module.exports = { createCode, redeem, authenticate, list, rename, revoke, ONLINE_MS, CODE_TTL_MS };
