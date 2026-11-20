#!/usr/bin/env node
'use strict';
// Train AI 5x protocol runner. Runs the frozen 10-task suite (suite.js) with a small model that works
// ONLY through a local Cortex (MCP tools), on a copy of a vault snapshot. Scores with hidden tests.
//   node experiments/train-ai/rounds.js --round 0 --snapshot <dir> [--trials 3] [--training-cost 0.12]
//   node experiments/train-ai/rounds.js --empty --trials 1          (pilot: empty Cortex)
// E = passes / (run dollars + training dollars). A task-trial passes only if every hidden case passes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const { Store } = require(path.join(ROOT, 'src', 'store'));
const { SUITE } = require('./suite');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const MODEL = arg('model', 'claude-haiku-5-5');
const TRIALS = Number(arg('trials', 3));
const ROUND = arg('round', flag('empty') ? 'empty' : '0');
const SNAPSHOT = flag('empty') ? null : arg('snapshot');
const TRAINING = Number(arg('training-cost', 0));
const CONC = Number(arg('concurrency', 4));
const ONLY = arg('tasks') ? arg('tasks').split(',') : null;
const OUT = arg('out', path.join(__dirname, 'rounds', `round-${ROUND}.json`));
if (!flag('empty') && !SNAPSHOT) { console.error('--snapshot <dir> is required (or --empty)'); process.exit(2); }

// The same frozen instruction every round: the agent is told only to work through Cortex.
const PREFIX = 'You are an AI agent working for the user through Cortex, their project manager and long-term memory. Use the cortex tools. ';

function makeVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'train5x-'));
  if (SNAPSHOT) fs.cpSync(SNAPSHOT, vault, { recursive: true });
  else { const s = new Store(vault); s.create('project', { title: 'Cortex' }); s.create('project', { title: 'Roblox games' }); s.create('project', { title: 'SkyBlock macros' }); }
  return vault;
}

function ask(vault, prompt) {
  const cfg = path.join(vault, '..', path.basename(vault) + '-mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { cortex: { command: process.execPath, args: [path.join(ROOT, 'bin', 'cortex.js'), 'mcp', '--vault', vault] } } }));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'train5x-cwd-'));
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--setting-sources', 'project', '--no-session-persistence',
      '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__cortex__*', '--tools', '', '--max-budget-usd', '0.15', '--', prompt],
    { cwd, maxBuffer: 20 << 20, timeout: 300000, windowsHide: true }, (err, stdout) => {
      let j = {};
      try { j = JSON.parse(stdout); } catch { j = { result: String(stdout || ''), is_error: true }; }
      const u = j.usage || {};
      fs.rmSync(cfg, { force: true }); fs.rmSync(cwd, { recursive: true, force: true });
      resolve({ text: String(j.result || ''), ms: Date.now() - t0, cost: Number(j.total_cost_usd || 0), turns: j.num_turns, out_tokens: Number(u.output_tokens || 0), in_tokens: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0), error: err ? String(err.message).slice(0, 200) : (j.is_error ? 'is_error' : undefined) });
    });
  });
}

const extract = (t) => ([...t.matchAll(/```(?:js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).sort((x, y) => y.length - x.length)[0]) || t;

(async () => {
  const tasks = SUITE.filter((t) => !ONLY || ONLY.includes(t.id));
  const jobs = [];
  for (const t of tasks) for (let i = 0; i < TRIALS; i++) jobs.push({ t, i });
  const runs = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { t, i } = jobs[next++];
      const vault = makeVault();
      const a = await ask(vault, PREFIX + t.prompt);
      const sc = t.score(extract(a.text));
      const pass = sc.passed === sc.total;
      runs.push({ task: t.id, trial: i + 1, pass, passed: sc.passed, total: sc.total, failures: sc.failures, ms: a.ms, cost: a.cost, turns: a.turns, out_tokens: a.out_tokens, in_tokens: a.in_tokens, error: a.error });
      console.log(`${t.id.padEnd(8)} #${i + 1}: ${pass ? 'PASS' : 'fail'} ${sc.passed}/${sc.total} · ${(a.ms / 1000).toFixed(0)}s · $${a.cost.toFixed(4)} · ${a.turns} turns${a.error ? ' · ' + a.error : ''}`);
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  runs.sort((a, b) => a.task.localeCompare(b.task) || a.trial - b.trial);
  const sum = (k) => runs.reduce((s, r) => s + (r[k] || 0), 0);
  const passes = runs.filter((r) => r.pass).length;
  const runCost = sum('cost');
  const total = runCost + TRAINING;
  const byTask = Object.fromEntries(tasks.map((t) => [t.id, `${runs.filter((r) => r.task === t.id && r.pass).length}/${TRIALS}`]));
  const summary = { round: ROUND, model: MODEL, trials: TRIALS, snapshot: SNAPSHOT, passes, runs: runs.length, pass_rate: +(passes / runs.length).toFixed(3),
    run_cost: +runCost.toFixed(4), training_cost: TRAINING, total_cost: +total.toFixed(4), E: total ? +(passes / total).toFixed(2) : null,
    avg_turns: +(sum('turns') / runs.length).toFixed(1), out_tokens: sum('out_tokens'), in_tokens: sum('in_tokens'), avg_seconds: +(sum('ms') / runs.length / 1000).toFixed(1), by_task: byTask };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ summary, date: new Date().toISOString(), runs }, null, 2));
  console.log(JSON.stringify(summary, null, 1));
})();
