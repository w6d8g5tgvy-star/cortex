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

async function runOne(conf, job, runner, sessions, log) {
  const cwd = folderFor(conf, job);
  if (!cwd) { await call(conf, '/api/runner/update', { id: job.id, status: 'error', step: 'No allowed folder on this computer. Start the runner with --folder "<path>".' }); return; }
  let run;
  try {
    await runner.available();
    run = runner.launch({ tool: job.tool, model: job.model, prompt: job.prompt, project: job.project, task: job.task, cwd, permission: conf.permission || 'acceptEdits', maxMinutes: conf.maxMinutes || 120, briefText: job.brief, from: 'cortex (remote)' });
  } catch (e) { await call(conf, '/api/runner/update', { id: job.id, status: 'error', step: e.message }); return; }
  log(`▶ ${job.id}: ${String(job.prompt || job.task).slice(0, 80)} (in ${cwd})`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = sessions.get(runner.vault, run.id) || {};
    const finished = s.status && s.status !== 'working';
    const status = finished ? (s.status === 'error' ? 'error' : 'done') : 'running';
    let resp = {};
    try { resp = await call(conf, '/api/runner/update', { id: job.id, status, step: s.step, result: finished ? s.result : undefined, cost_usd: s.cost_usd }); } catch (e) { log(`  (could not report: ${e.message})`); }
    if (resp.stop && !finished) { runner.stop(run.id); try { await call(conf, '/api/runner/update', { id: job.id, status: 'stopped', step: 'Stopped by you' }); } catch { /* reported next time */ } log(`■ ${job.id} stopped`); return; }
    if (finished) { log(`${status === 'done' ? '✓' : '✗'} ${job.id}: ${String(s.step || '').slice(0, 100)}`); return; }
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
  let backoff = 5000;
  for (;;) {
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

module.exports = { start, pair, folderFor, loadConf, HOME };
