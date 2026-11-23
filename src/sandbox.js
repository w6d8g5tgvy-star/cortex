'use strict';
// AI simulation sandbox (2.2 #12): try prompts, instructions, skills, tools or code changes on a COPY of a project.
// The copy leaves out secrets and dependency folders (same rules as SmartSave). Commands run with a clean environment
// (no API keys or tokens passed through), a time limit, an output limit and, optionally, a cost limit for agent runs.
// Changes reach the real project only through apply(), which needs explicit approval, saves a SmartSave checkpoint
// first, and never deletes files. Honest limit: network access cannot be fully blocked without OS support; by default
// proxies are pointed at a dead address so ordinary HTTP clients fail, and this is reported as "best effort".
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { scan, secretIn, safeRel } = require('./smartsave/scan');

const ROOT = () => path.join(os.tmpdir(), 'cortex-sandboxes');
const KEEP_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'TERM', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'];

function create(projectRoot, { name = 'sandbox' } = {}) {
  const src = path.resolve(projectRoot);
  if (!fs.existsSync(src)) throw new Error(`Folder not found: ${projectRoot}`);
  const id = 'sbx-' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(ROOT(), id);
  fs.mkdirSync(dir, { recursive: true });
  const r = scan(src);
  let copied = 0; const skipped = [...r.skipped];
  for (const f of r.files) {
    const buf = fs.readFileSync(path.join(src, f.path));
    const s = secretIn(buf); if (s) { skipped.push({ path: f.path, reason: `contains ${s}` }); continue; }
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), buf); copied++;
  }
  const meta = { id, name, source: src, dir, created: new Date().toISOString(), copied, skipped: skipped.slice(0, 100), runs: [] };
  fs.writeFileSync(path.join(dir, '.cortex-sandbox.json'), JSON.stringify(meta, null, 1));
  return meta;
}
function load(id) { if (!/^sbx-[a-f0-9]{8}$/.test(id)) throw new Error('bad sandbox id'); const f = path.join(ROOT(), id, '.cortex-sandbox.json'); return JSON.parse(fs.readFileSync(f, 'utf8')); }
function saveMeta(m) { fs.writeFileSync(path.join(m.dir, '.cortex-sandbox.json'), JSON.stringify(m, null, 1)); }

/** Run a command inside the sandbox with limits. Returns { code, out, timedOut, ms }. */
function run(id, cmd, args = [], { timeoutMs = 120000, maxOutput = 200000, allowNetwork = false, input = null } = {}) {
  const m = load(id);
  const env = {}; for (const k of KEEP_ENV) if (process.env[k]) env[k] = process.env[k];
  env.CORTEX_SANDBOX = m.id; env.CORTEX_QUIET = '1';
  if (!allowNetwork) Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '' });
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = ''; let done = false; let timedOut = false;
    const child = spawn(cmd, args, { cwd: m.dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const add = (d) => { if (out.length < maxOutput) out += d; };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.stdin.on('error', () => {}); if (input) child.stdin.end(input); else child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); const r = { code, out: out.slice(0, maxOutput), timedOut, ms: Date.now() - t0, network: allowNetwork ? 'allowed' : 'blocked (best effort: proxies point at a dead address)' }; m.runs.push({ cmd: [cmd, ...args].join(' ').slice(0, 200), code, ms: r.ms, timedOut, at: new Date().toISOString() }); saveMeta(m); resolve(r); };
    child.on('error', (e) => { out += e.message; finish(-1); });
    child.on('close', finish);
  });
}

/** What changed in the sandbox compared with the real project. */
function diff(id) {
  const m = load(id);
  const now = scan(m.dir).files.filter((f) => f.path !== '.cortex-sandbox.json');
  const out = { added: [], changed: [], removed: [] };
  const seen = new Set();
  for (const f of now) {
    seen.add(f.path);
    const real = path.join(m.source, f.path);
    if (!fs.existsSync(real)) out.added.push(f.path);
    else if (!fs.readFileSync(real).equals(fs.readFileSync(path.join(m.dir, f.path)))) out.changed.push(f.path);
  }
  for (const f of scan(m.source).files) if (!seen.has(f.path) && !m.skipped.some((s) => s.path === f.path)) out.removed.push(f.path);
  return out;
}

/**
 * Copy approved changes back to the real project. Requires approved:true. Takes a SmartSave checkpoint first when a
 * SmartSave instance is given. Never deletes real files (removals are reported, not applied).
 */
function apply(id, { approved, files = null, smart = null, project = null } = {}) {
  if (approved !== true) throw new Error('Applying sandbox changes to the real project needs your approval.');
  const m = load(id); const d = diff(id);
  let checkpoint = null;
  if (smart && project) { try { checkpoint = smart.checkpoint(project, { reason: 'before applying sandbox changes', force: true }).snapshot; } catch { /* not enabled */ } }
  const want = new Set(files || [...d.added, ...d.changed]);
  const applied = [];
  for (const p of [...d.added, ...d.changed]) {
    if (!want.has(p) || !safeRel(p)) continue;
    const dest = path.join(m.source, p);
    if (!path.resolve(dest).startsWith(path.resolve(m.source) + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(m.dir, p), dest); applied.push(p);
  }
  return { applied, notDeleted: d.removed, checkpoint };
}
function destroy(id) { const m = load(id); fs.rmSync(m.dir, { recursive: true, force: true }); return { destroyed: id }; }
function list() { try { return fs.readdirSync(ROOT()).filter((n) => /^sbx-/.test(n)).map((n) => { try { const m = load(n); return { id: m.id, name: m.name, source: m.source, created: m.created, runs: m.runs.length }; } catch { return null; } }).filter(Boolean); } catch { return []; } }

module.exports = { create, run, diff, apply, destroy, list, load };
