'use strict';
// Self-updater. Sources:
//   - git checkout of the app folder  → git pull --ff-only
//   - "github:owner/repo" or "owner/repo" → latest GitHub release (source tarball)
//   - "https://.../latest.json"         → manifest { version, url, sha256?, notes? } (url must be .tar.gz)
// Updates are staged, the current files are backed up, and the supervisor in bin/cortex.js
// rolls back automatically if the new version fails to start.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const APP = path.resolve(__dirname, '..');
const UPD = path.join(APP, '.update');
const MANAGED = ['bin', 'src', 'public', 'test', 'integrations', 'scripts', 'package.json', 'README.md', 'LICENSE', 'Start Cortex.bat', 'Start Cortex.command', 'start-cortex.sh', 'Setup Cortex.bat', 'Setup Cortex.command', 'setup-cortex.sh'];
const currentVersion = () => JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

const git = (args) => new Promise((res, rej) => execFile('git', args, { cwd: APP, timeout: 60000 }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim())) : res(String(out).trim()))));
const isGit = () => fs.existsSync(path.join(APP, '.git'));

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'cortex-updater', Accept: 'application/vnd.github+json, application/json' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

/** Returns { mode, current, latest, available, url?, sha256?, notes? } */
async function check(source) {
  const current = currentVersion();
  if (isGit()) {
    await git(['fetch', '--quiet']);
    const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}']).catch(() => '0'));
    let latest = current;
    try { latest = JSON.parse(await git(['show', '@{u}:package.json'])).version; } catch { /* keep */ }
    return { mode: 'git', current, latest, available: behind > 0, notes: behind ? await git(['log', '--oneline', 'HEAD..@{u}']).catch(() => '') : '' };
  }
  const src = String(source || '').trim();
  if (!src) return { mode: 'none', current, latest: current, available: false, error: 'No update source configured' };
  if (/^https:\/\//i.test(src) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(src)) {
    const m = await getJson(src);
    if (!m.version || !m.url) throw new Error('Manifest must contain "version" and "url"');
    return { mode: 'manifest', current, latest: String(m.version).replace(/^v/, ''), available: cmpVer(m.version, current) > 0, url: m.url, sha256: m.sha256, notes: m.notes || '' };
  }
  const repo = src.replace(/^github:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid update source "${src}". Use owner/repo or an https manifest URL.`);
  const rel = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const shaAsset = (rel.assets || []).find((a) => /sha256/i.test(a.name));
  let sha256;
  if (shaAsset) { try { sha256 = (await (await fetch(shaAsset.browser_download_url)).text()).trim().split(/\s+/)[0]; } catch { /* optional */ } }
  const tarAsset = (rel.assets || []).find((a) => /\.(tar\.gz|tgz)$/i.test(a.name));
  return { mode: 'github', repo, current, latest, available: cmpVer(latest, current) > 0, url: tarAsset ? tarAsset.browser_download_url : rel.tarball_url, sha256, notes: rel.body || '' };
}

// ---- minimal tar reader ----
function untar(buf, dest) {
  let off = 0;
  let longName = null;
  let paxPath = null;
  const files = [];
  const str = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    let name = str(h.subarray(0, 100));
    if (prefix) name = prefix + '/' + name;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(data); continue; }
    if (type === 'x') { const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '\0' || type === '7') files.push({ name, data, mode: parseInt(str(h.subarray(100, 108)) || '644', 8) });
  }
  // strip a common top-level folder (GitHub tarballs use owner-repo-sha/)
  const tops = new Set(files.map((f) => f.name.split('/')[0]));
  const strip = tops.size === 1 && files.every((f) => f.name.includes('/'));
  for (const f of files) {
    const rel = strip ? f.name.split('/').slice(1).join('/') : f.name;
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data, { mode: f.mode & 0o777 || 0o644 });
  }
}

function writePending(obj) { fs.mkdirSync(UPD, { recursive: true }); fs.writeFileSync(path.join(UPD, 'pending.json'), JSON.stringify(obj, null, 2)); }
function readPending() { try { return JSON.parse(fs.readFileSync(path.join(UPD, 'pending.json'), 'utf8')); } catch { return null; } }

/** Download + install. Returns { from, to }. Caller must restart the process. */
async function apply(info) {
  try { fs.accessSync(APP, fs.constants.W_OK); } catch { throw new Error(`The app folder is not writable: ${APP}`); }
  const from = currentVersion();
  if (info.mode === 'git') {
    const head = await git(['rev-parse', 'HEAD']);
    await git(['pull', '--ff-only']);
    writePending({ from, to: currentVersion(), mode: 'git', head, ts: new Date().toISOString(), confirmed: false });
    return { from, to: currentVersion() };
  }
  if (!info.url) throw new Error('No download URL');
  const r = await fetch(info.url, { headers: { 'User-Agent': 'cortex-updater' } });
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
  const gz = Buffer.from(await r.arrayBuffer());
  if (info.sha256) {
    const got = crypto.createHash('sha256').update(gz).digest('hex');
    if (got.toLowerCase() !== String(info.sha256).toLowerCase()) throw new Error('Checksum mismatch: update rejected');
  }
  const staging = path.join(UPD, 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  untar(zlib.gunzipSync(gz), staging);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')); } catch { throw new Error('Update package is missing package.json'); }
  if (pkg.name !== 'cortex-os' || !fs.existsSync(path.join(staging, 'bin', 'cortex.js'))) throw new Error('Update package is not a Cortex release');
  // back up current version
  const backup = path.join(UPD, 'backup');
  fs.rmSync(backup, { recursive: true, force: true });
  fs.mkdirSync(backup, { recursive: true });
  for (const item of MANAGED) if (fs.existsSync(path.join(APP, item))) fs.cpSync(path.join(APP, item), path.join(backup, item), { recursive: true });
  // install
  for (const item of MANAGED) {
    const src = path.join(staging, item);
    if (!fs.existsSync(src)) continue;
    fs.rmSync(path.join(APP, item), { recursive: true, force: true });
    fs.cpSync(src, path.join(APP, item), { recursive: true });
  }
  for (const exe of ['bin/cortex.js', 'start-cortex.sh', 'Start Cortex.command']) { try { fs.chmodSync(path.join(APP, exe), 0o755); } catch { /* windows */ } }
  fs.rmSync(staging, { recursive: true, force: true });
  writePending({ from, to: pkg.version, mode: info.mode, ts: new Date().toISOString(), confirmed: false });
  return { from, to: pkg.version };
}

/** Called by the new version once it has started successfully. */
function confirm() {
  const p = readPending();
  if (p && !p.confirmed) { p.confirmed = true; p.confirmedAt = new Date().toISOString(); writePending(p); return p; }
  return null;
}

/** Restore the previous version (used by the supervisor when an update fails to start). */
async function rollback() {
  const p = readPending();
  if (!p || p.confirmed) return false;
  if (p.mode === 'git' && p.head) await git(['reset', '--hard', p.head]);
  else {
    const backup = path.join(UPD, 'backup');
    if (!fs.existsSync(backup)) return false;
    for (const item of MANAGED) {
      if (!fs.existsSync(path.join(backup, item))) continue;
      fs.rmSync(path.join(APP, item), { recursive: true, force: true });
      fs.cpSync(path.join(backup, item), path.join(APP, item), { recursive: true });
    }
  }
  writePending({ ...p, confirmed: true, rolledBack: true, failedVersion: p.to });
  return true;
}

module.exports = { check, apply, confirm, rollback, readPending, cmpVer, currentVersion, untar, APP };
