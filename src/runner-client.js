'use strict';
// Runner mode: lets a second computer run agent jobs for your main Cortex.
//   First time:  node bin/cortex.js runner --hub https://home.example.ts.net --code ABCD-EFGH --folder "C:\Users\me\Code"
//   After that:  node bin/cortex.js runner
// The computer pairs once with a short code from the main Cortex (Settings → Devices), stores its own key in
// ~/.cortex-runner/config.json, then asks the main Cortex for jobs, runs them with Claude Code or Codex in an allowed
// folder, and reports progress. It only runs jobs from the Cortex it paired with, only in folders you allowed here.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.CORTEX_RUNNER_HOME || path.join(os.homedir(), '.cortex-runner');
const CONF = path.join(HOME, 'config.json');
const VERSION = require('../package.json').version;

function loadConf() { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } }
function saveConf(c) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 }); }
const cleanHub = (h) => String(h || '').trim().replace(/\/+$/, '').replace(/\/mcp\/.*$/, '');

async function call(conf, route, body) {
  const r = await fetch(conf.hub + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + conf.token, 'X-Cortex-Platform': `${os.platform()} ${os.hostname()}`.slice(0, 40), 'X-Cortex-Version': VERSION },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

async function pair({ hub, code, name, folders }) {
  hub = cleanHub(hub);
  if (!/^https?:\/\//.test(hub)) throw new Error('--hub must be the address of your main Cortex, e.g. https://home.example.ts.net');
  const r = await fetch(hub + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: name || os.hostname(), platform: `${os.platform()} ${os.hostname()}`, version: VERSION }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Pairing failed (HTTP ${r.status})`);
  if (!j.token) throw new Error('That code is for a phone. Make a "Computer" code in Settings → Devices.');
  const conf = { hub, token: j.token, device: j.device, folders: (folders || []).map((f) => path.resolve(f)), projects: {} };
  saveConf(conf);
  return conf;
}

/** Pick the folder for a job: a project→folder mapping on this computer, else the first allowed folder. */
function folderFor(conf, job) {
  const mapped = job.project && conf.projects && conf.projects[job.project];
  const cands = [mapped, ...(conf.folders || [])].filter(Boolean);
  return cands.find((f) => fs.existsSync(f) && (conf.folders || []).some((a) => path.resolve(f).toLowerCase().startsWith(path.resolve(a).toLowerCase())));
}

// ---------- SmartSave on this computer: protect its work (upload to the main Cortex) and keep copies of the main
// Cortex's checkpoints (replication), so either computer can die without losing unfinished work ----------
let smart = null;
async function smartSave(conf, log) {
  if (smart) return smart;
  try {
    const r = await call(conf, '/api/runner/smartsave-key');
    const { SmartSave } = require('./smartsave');
    const key = SmartSave.parseRecoveryKey(r.key);
    const current = { projects: {} };
    const ss = new SmartSave({ home: path.join(HOME, 'smartsave'), key, device: (conf.device && conf.device.name) || os.hostname(), config: () => ({ enabled: true, projects: current.projects, targets: [{ id: 'main', type: 'cortex', name: 'Main Cortex', hub: conf.hub, token: conf.token }] }) });
    smart = { ss, current };
  } catch (e) { log(`(SmartSave not available: ${e.message})`); smart = { ss: null }; }
  return smart;
}
async function checkpointJob(conf, ws, cwd, reason, log) {
  const s = await smartSave(conf, log);
  if (!s.ss) return null;
  s.current.projects = { [ws]: { enabled: true, root: cwd } };
  try { const r = s.ss.checkpoint(ws, { reason, root: cwd }); await s.ss.uploadPending({ maxMs: 30000 }); return r; } catch (e) { log(`  (SmartSave: ${e.message})`); return null; }
}
/** Copy the main Cortex's new checkpoints here and tell it they're safe on this computer. */
async function replicate(conf, log) {
  const s = await smartSave(conf, log);
  if (!s.ss) return 0;
  const { CortexTarget } = require('./smartsave/targets');
  const tg = new CortexTarget({ hub: conf.hub, token: conf.token });
  const feed = await call(conf, '/api/runner/smartsave-feed', { since: conf.replicaCursor || '' });
  const done = [];
  for (const it of feed.items || []) {
    try { await s.ss.fetchFrom(tg, it.ws, it.id); s.ss.repo.verifySnapshot(it.ws, it.id).ok && done.push(it); conf.replicaCursor = it.id; } catch (e) { log(`  (copy of ${it.ws} failed: ${e.message})`); break; }
  }
  if (done.length) { await call(conf, '/api/runner/smartsave-ack', { items: done }); saveConf(conf); }
  return done.length;
}

// ---------- standby host: keep a copy of the main vault; serve it while the main computer is off ----------
const SB = { vault: path.join(HOME, 'standby-vault'), child: null, takeoverAt: 0, baseline: null, firstFail: 0, lastSync: 0, synced: false };
const SBFILE = path.join(HOME, 'standby.json');
function sbState() { try { return JSON.parse(fs.readFileSync(SBFILE, 'utf8')); } catch { return {}; } }
function sbSave(x) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(SBFILE, JSON.stringify(x)); }
async function standbySync(conf, log) {
  const sb = require('./standby');
  fs.mkdirSync(SB.vault, { recursive: true });
  let n = 0;
  for (let i = 0; i < 50; i++) { // chunked
    const resp = await call(conf, '/api/runner/vault-changes', { known: sb.index(SB.vault) });
    n += sb.applyChanges(SB.vault, resp).wrote;
    if (!resp.more) break;
  }
  SB.lastSync = Date.now(); SB.synced = true; sbSave({ ...sbState(), lastSync: SB.lastSync, synced: true });
  if (n) log(`Standby copy updated (${n} file${n === 1 ? '' : 's'}).`);
  return n;
}
function standbyTakeover(conf, opts, log) {
  if (SB.child) return;
  const sb = require('./standby');
  SB.baseline = sb.index(SB.vault); SB.takeoverAt = Date.now();
  fs.mkdirSync(path.join(SB.vault, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(SB.vault, '.cortex', 'standby.json'), JSON.stringify({ active: true, since: new Date(SB.takeoverAt).toISOString(), main: conf.hub, device: (conf.device && conf.device.name) || os.hostname(), lastSync: new Date(SB.lastSync).toISOString() }));
  sbSave({ ...sbState(), active: true, takeoverAt: SB.takeoverAt, baseline: SB.baseline });
  const { spawn } = require('child_process');
  SB.child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', SB.vault, '--port', String(opts.port || 7777)], { stdio: 'ignore', env: { ...process.env, CORTEX_STANDBY: '1' } });
  log(`Main Cortex has been unreachable for ${opts.takeoverMinutes || 5} minutes: now serving the standby copy at http://localhost:${opts.port || 7777} (last copied ${new Date(SB.lastSync).toLocaleString()}).`);
}
async function standbyHandback(conf, log) {
  const sb = require('./standby');
  const st = sbState();
  const files = sb.changedSince(SB.vault, SB.takeoverAt || st.takeoverAt || 0).filter((f) => !f.path.startsWith('.cortex/'));
  const r = await call(conf, '/api/runner/vault-import', { files, baseline: SB.baseline || st.baseline || {} });
  if (SB.child) { try { SB.child.kill(); } catch { /* gone */ } SB.child = null; }
  try { fs.rmSync(path.join(SB.vault, '.cortex', 'standby.json'), { force: true }); } catch { /* ok */ }
  sbSave({ ...st, active: false, takeoverAt: 0, baseline: null, lastHandback: Date.now() });
  SB.takeoverAt = 0; SB.baseline = null;
  log(`Main Cortex is back: handed back ${r.written.length} changed file(s)${r.conflicts.length ? ` (${r.conflicts.length} edited in both places: both versions kept)` : ''}. Standby copy is passive again.`);
  await standbySync(conf, log);
  return r;
}

async function runOne(conf, job, runner, sessions, log) {
  let cwd = folderFor(conf, job);
  const ws = /^[\w-]{1,80}$/.test(job.project || '') ? job.project : 'unsorted';
  if (cwd && job.restore) {
    // continue unfinished work: restore the checkpoint (from the main Cortex) into a new folder here
    try {
      const s = await smartSave(conf, log);
      const { CortexTarget } = require('./smartsave/targets');
      await s.ss.fetchFrom(new CortexTarget({ hub: conf.hub, token: conf.token }), job.restore.ws, job.restore.id);
      const dest = path.join(cwd, `${job.restore.ws}-restored-${job.restore.id.slice(0, 9)}`);
      const r = s.ss.restore(job.restore.ws, job.restore.id, { dest });
      if (r.failed.length) throw new Error(`${r.failed.length} files could not be restored`);
      log(`  restored ${r.written + r.same} files into ${dest}`);
      cwd = dest;
    } catch (e) { await call(conf, '/api/runner/update', { id: job.id, status: 'error', step: `Could not restore the checkpoint: ${e.message}` }); return; }
  }
  if (!cwd) { await call(conf, '/api/runner/update', { id: job.id, status: 'error', step: 'No allowed folder on this computer. Start the runner with --folder "<path>".' }); return; }
  let run;
  try {
    await runner.available();
    run = runner.launch({ tool: job.tool, model: job.model, prompt: job.prompt, project: job.project, task: job.task, cwd, permission: conf.permission || 'acceptEdits', maxMinutes: conf.maxMinutes || 120, briefText: job.brief, from: 'cortex (remote)' });
  } catch (e) { await call(conf, '/api/runner/update', { id: job.id, status: 'error', step: e.message }); return; }
  log(`▶ ${job.id}: ${String(job.prompt || job.task).slice(0, 80)} (in ${cwd})`);
  let lastSave = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    if (Date.now() - lastSave > 120000) { lastSave = Date.now(); checkpointJob(conf, ws, cwd, 'while the agent works', log); }
    const s = sessions.get(runner.vault, run.id) || {};
    const finished = s.status && s.status !== 'working';
    const status = finished ? (s.status === 'error' ? 'error' : 'done') : 'running';
    let resp = {};
    try { resp = await call(conf, '/api/runner/update', { id: job.id, status, step: s.step, result: finished ? s.result : undefined, cost_usd: s.cost_usd }); } catch (e) { log(`  (could not report: ${e.message})`); }
    if (resp.stop && !finished) { runner.stop(run.id); try { await call(conf, '/api/runner/update', { id: job.id, status: 'stopped', step: 'Stopped by you' }); } catch { /* reported next time */ } log(`■ ${job.id} stopped`); return; }
    if (finished) { await checkpointJob(conf, ws, cwd, status === 'done' ? 'agent finished' : 'agent stopped', log); log(`${status === 'done' ? '✓' : '✗'} ${job.id}: ${String(s.step || '').slice(0, 100)}`); return; }
  }
}

async function start(opts, log = console.log) {
  let conf = loadConf();
  if (opts.code) conf = await pair({ hub: opts.hub || conf.hub, code: opts.code, name: opts.name, folders: opts.folders && opts.folders.length ? opts.folders : conf.folders });
  else if (opts.folders && opts.folders.length) { conf.folders = opts.folders.map((f) => path.resolve(f)); saveConf(conf); }
  if (!conf.token || !conf.hub) throw new Error('Not paired yet. In your main Cortex open Settings → Devices → Add a computer, then run:\n  node bin/cortex.js runner --hub <main Cortex address> --code <code> --folder <your code folder>');
  if (!(conf.folders || []).length) log('Note: no allowed folder yet, so jobs will fail. Restart with --folder "<path>".');
  const { Store } = require('./store');
  const { AgentRunner } = require('./agents');
  const sessions = require('./sessions');
  const store = new Store(path.join(HOME, 'vault'));
  const runner = new AgentRunner(store);
  log(`Cortex runner ${VERSION}: "${(conf.device && conf.device.name) || os.hostname()}" connected to ${conf.hub}. Allowed folders: ${(conf.folders || []).join(', ') || 'none'}. Waiting for jobs (Ctrl+C to stop).`);
  let backoff = 5000; let lastReplica = 0;
  if (opts.standby) {
    const st = sbState();
    if (st.active && st.takeoverAt) { SB.takeoverAt = st.takeoverAt; SB.baseline = st.baseline; } // resumed after a restart while serving
    log(`Standby mode on: keeping a copy of the main Cortex in ${SB.vault}; takes over after ${opts.takeoverMinutes || 5} minutes without the main computer.`);
  }
  for (;;) {
    if (opts.standby) {
      try {
        await call(conf, '/api/runner/ping');
        SB.firstFail = 0;
        if (SB.child || SB.takeoverAt) await standbyHandback(conf, log);
        else if (Date.now() - SB.lastSync > (opts.once ? 0 : 2 * 60000)) await standbySync(conf, log);
      } catch (e) {
        if (e.status === 401) throw new Error('This computer was removed from Cortex. Pair it again with a new code.');
        if (!SB.firstFail) SB.firstFail = Date.now();
        const waited = (Date.now() - SB.firstFail) / 60000;
        if (!SB.child && (SB.synced || sbState().synced) && waited >= (opts.takeoverMinutes ?? 5)) standbyTakeover(conf, opts, log);
      }
      if (SB.child) { if (opts.once) return; await new Promise((res) => setTimeout(res, 15000)); continue; } // serving: don't take jobs from the (absent) main
    }
    if (Date.now() - lastReplica > (opts.once ? 0 : 5 * 60000)) { lastReplica = Date.now(); try { const n = await replicate(conf, log); if (n) log(`Kept a copy of ${n} checkpoint${n === 1 ? '' : 's'} from the main Cortex.`); } catch (e) { if (e.status === 401) throw new Error('This computer was removed from Cortex. Pair it again with a new code.'); } }
    try {
      const r = await call(conf, '/api/runner/next');
      backoff = 5000;
      if (r.job) { await runOne(conf, r.job, runner, sessions, log); continue; }
    } catch (e) {
      if (e.status === 401) throw new Error('This computer was removed from Cortex (or its key is no longer valid). Pair it again with a new code.');
      log(`Main Cortex not reachable (${e.message}). Retrying…`);
      backoff = Math.min(backoff * 2, 60000);
    }
    if (opts.once) return;
    await new Promise((res) => setTimeout(res, backoff));
  }
}

module.exports = { start, pair, folderFor, loadConf, replicate, HOME, SB, _reset: () => { smart = null; }, _stopStandby: () => { if (SB.child) { try { SB.child.kill(); } catch { /* gone */ } SB.child = null; } } };
