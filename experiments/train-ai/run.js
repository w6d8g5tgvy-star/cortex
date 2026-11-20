#!/usr/bin/env node
'use strict';
// Train AI experiment: does teaching a smaller Claude model through Cortex make it better at a task?
// For each task: run the model N times WITHOUT teaching (baseline) and N times WITH the lessons Cortex's
// lesson picker serves for that task (taught). Score every answer with hidden tests run locally (not by the model).
// Usage: node experiments/train-ai/run.js [--model claude-haiku-5-5] [--trials 3] [--tasks semver,journal] [--out results.json]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const { Store } = require(path.join(ROOT, 'src', 'store'));
const fetcher = require(path.join(ROOT, 'src', 'fetcher'));
const select = require(path.join(ROOT, 'src', 'lesson-select'));
const TASKS = require('./tasks');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model', 'claude-haiku-5-5');
const TRIALS = Number(arg('trials', 3));
const ONLY = arg('tasks', Object.keys(TASKS).join(',')).split(',');
const OUT = arg('out', path.join(__dirname, 'results.json'));

function ask(prompt) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--tools', '', '--', prompt], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 << 20, timeout: 240000 }, (err, stdout) => {
      let j = {};
      try { j = JSON.parse(stdout); } catch { j = { result: String(stdout || ''), is_error: true }; }
      const u = j.usage || {};
      resolve({ text: String(j.result || ''), ms: Date.now() - t0, cost: Number(j.total_cost_usd || 0), out_tokens: Number(u.output_tokens || 0), in_tokens: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0), error: err ? err.message : (j.is_error ? 'model error' : undefined) });
    });
  });
}

function extractCode(text) {
  const blocks = [...String(text).matchAll(/```(?:js|javascript|node)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.length ? blocks.sort((a, b) => b.length - a.length)[0] : String(text);
}

/** Put the task's lesson into a fresh vault the way Fetcher does, then ask Cortex's picker what it would serve. */
function lessonsFor(task) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'train-ai-'));
  const store = new Store(vault);
  for (const l of task.lessons) fetcher.teach(store, { topic: l.topic, threshold: 60, videos: l.sources.map((s, i) => ({ id: 'src' + i, title: s, score: 85, verdict: 'worth it', review: { techniques: l.techniques.map((t) => ({ evidence: 'from the source', ...t })) } })) });
  const picks = select.select(store, { text: task.prompt, max: 5, minScore: 2 });
  fs.rmSync(vault, { recursive: true, force: true });
  return picks;
}

(async () => {
  const results = { model: MODEL, trials: TRIALS, date: new Date().toISOString(), tasks: {} };
  for (const name of ONLY) {
    const task = TASKS[name];
    const picks = lessonsFor(task);
    const taught = `${task.prompt}\n\n[Cortex] Vetted techniques that fit this task (from lessons in memory; say which one you use):\n${picks.map((p) => `- ${p.line}`).join('\n')}`;
    const r = { served_lessons: picks.map((p) => p.name), baseline: [], taught: [] };
    for (const [cond, prompt] of [['baseline', task.prompt], ['taught', taught]]) {
      for (let i = 0; i < TRIALS; i++) {
        const a = await ask(prompt);
        const score = a.error ? { passed: 0, total: task.total, failures: [a.error] } : task.score(extractCode(a.text));
        r[cond].push({ ...score, ms: a.ms, cost: a.cost, out_tokens: a.out_tokens, in_tokens: a.in_tokens, used_technique: cond === 'taught' ? picks.some((p) => a.text.toLowerCase().includes(p.name.toLowerCase().slice(0, 18))) : undefined });
        console.log(`${name} ${cond} #${i + 1}: ${score.passed}/${score.total} tests · ${(a.ms / 1000).toFixed(1)}s · $${a.cost.toFixed(4)} · ${a.out_tokens} out tokens`);
      }
    }
    const avg = (xs, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;
    r.summary = Object.fromEntries(['baseline', 'taught'].map((c) => [c, { pass_rate: +(avg(r[c], 'passed') / task.total).toFixed(3), perfect_runs: r[c].filter((x) => x.passed === x.total).length, avg_seconds: +(avg(r[c], 'ms') / 1000).toFixed(1), avg_cost: +avg(r[c], 'cost').toFixed(4), avg_out_tokens: Math.round(avg(r[c], 'out_tokens')) }]));
    results.tasks[name] = r;
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(results.tasks).map(([k, v]) => [k, { lessons: v.served_lessons, ...v.summary }])), null, 1));
})();
