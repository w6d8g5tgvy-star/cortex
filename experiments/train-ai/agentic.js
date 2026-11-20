#!/usr/bin/env node
'use strict';
// Train AI experiment 2: a small model works through a real (local) Cortex with its MCP tools.
//  A) Fetcher decisions: for each task, does the model correctly decide whether to request Fetcher research,
//     and does a request actually land on the task (waiting for approval)?
//  B) Recall: with no lesson pasted in, does the model find the lesson through Cortex memory and pass hidden tests?
// Usage: node experiments/train-ai/agentic.js [--model claude-haiku-5-5] [--trials 2] [--out file]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const { Store } = require(path.join(ROOT, 'src', 'store'));
const fetcher = require(path.join(ROOT, 'src', 'fetcher'));
const tf = require(path.join(ROOT, 'src', 'task-fetcher'));
const TASKS = require('./tasks');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model', 'claude-haiku-5-5');
const TRIALS = Number(arg('trials', 2));
const OUT = arg('out', path.join(__dirname, 'results-agentic.json'));

function freshVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'train-agentic-'));
  const store = new Store(vault);
  store.create('project', { title: 'Shop' });
  return { vault, store };
}

function ask(vault, prompt) {
  const cfg = path.join(vault, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { cortex: { command: process.execPath, args: [path.join(ROOT, 'bin', 'cortex.js'), 'mcp', '--vault', vault] } } }));
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__cortex__*', '--tools', '', '--', prompt],
      { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 << 20, timeout: 300000 }, (err, stdout) => {
        let j = {};
        try { j = JSON.parse(stdout); } catch { j = { result: String(stdout || ''), is_error: true }; }
        const u = j.usage || {};
        resolve({ text: String(j.result || ''), ms: Date.now() - t0, cost: Number(j.total_cost_usd || 0), turns: j.num_turns, out_tokens: Number(u.output_tokens || 0), error: err ? err.message.slice(0, 200) : undefined });
      });
  });
}

// Ground truth: is research worth it? (labelled by hand: hard + "better way" → yes; small mechanical → no)
const DECISIONS = [
  { title: 'Find a faster, more reliable way to run our 40-minute flaky Playwright test suite', body: 'CI runs 40 minutes and fails randomly with timeouts. We tried retries; it did not work. Research proven ways to speed up and stabilise large end-to-end suites.', worth: true },
  { title: 'Improve player retention in our Roblox tycoon: research what top tycoons do in the first 10 minutes', body: 'Day-1 retention is 8%. We need proven onboarding and early-reward techniques from successful games.', worth: true },
  { title: 'Fix typo in README', body: 'The word "recieve" in the install section should be "receive".', worth: false },
  { title: 'Rename the variable usr to user in login.js', body: 'Just a rename for readability.', worth: false },
];

(async () => {
  const res = { model: MODEL, trials: TRIALS, date: new Date().toISOString(), decisions: [], recall: [] };
  // ---- A) decisions ----
  for (const d of DECISIONS) {
    for (let i = 0; i < TRIALS; i++) {
      const { vault, store } = freshVault();
      const t = store.create('task', { title: d.title, body: d.body, project: 'shop' });
      const a = await ask(vault, `You are an AI agent working through Cortex (the user's project manager; use the cortex tools). Your task id is "${t.id}". Read your task, then decide whether asking Cortex Fetcher to research it is worth it (it costs some AI, and the user must approve it). If it is worth it, request it for this task. Do not do the task itself. End your reply with exactly one line: DECISION: REQUESTED or DECISION: NOT REQUESTED`);
      store.scan(false);
      const reqs = tf.requests(store, t.id);
      const requested = reqs.length > 0;
      const said = /DECISION:\s*REQUESTED/i.test(a.text) && !/NOT REQUESTED/i.test(a.text.split('DECISION:').pop());
      const landed = requested && reqs.every((j) => j.status === 'needs-approval') && /Waiting for your OK/.test(store.get(t.id).body);
      res.decisions.push({ task: d.title, worth: d.worth, requested, said_requested: said, correct: requested === d.worth, landed_on_task: requested ? landed : null, used_advice: /fetcher_advice|worth it|score/i.test(a.text), ms: a.ms, cost: a.cost, turns: a.turns, error: a.error });
      console.log(`decision ${d.worth ? 'WORTH' : 'TRIVIAL'} #${i + 1}: requested=${requested} (${requested === d.worth ? 'correct' : 'WRONG'})${requested ? ` landed=${landed}` : ''} · ${(a.ms / 1000).toFixed(0)}s · $${a.cost.toFixed(4)}`);
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }
  // ---- B) recall through memory (no lesson pasted in) ----
  const task = TASKS.journal;
  for (const withLesson of [false, true]) {
    for (let i = 0; i < 3; i++) {
      const { vault, store } = freshVault();
      if (withLesson) for (const l of task.lessons) fetcher.teach(store, { topic: l.topic, threshold: 60, videos: [{ id: 'x', title: l.sources[0], score: 85, verdict: 'worth it', review: { techniques: l.techniques.map((t) => ({ evidence: 'from the source', ...t })) } }] });
      const a = await ask(vault, `You are an AI agent working through Cortex (use the cortex tools; search Cortex memory before assuming anything). ${task.prompt}`);
      const code = ([...a.text.matchAll(/```(?:js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).sort((x, y) => y.length - x.length)[0]) || a.text;
      const sc = task.score(code);
      res.recall.push({ lesson_in_memory: withLesson, passed: sc.passed, total: sc.total, ms: a.ms, cost: a.cost, turns: a.turns, out_tokens: a.out_tokens, error: a.error });
      console.log(`recall ${withLesson ? 'lesson in memory' : 'empty memory   '} #${i + 1}: ${sc.passed}/${sc.total} · ${(a.ms / 1000).toFixed(0)}s · $${a.cost.toFixed(4)} · ${a.turns} turns`);
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }
  const dec = res.decisions;
  res.summary = {
    decision_accuracy: `${dec.filter((x) => x.correct).length}/${dec.length}`,
    worth_requested: `${dec.filter((x) => x.worth && x.requested).length}/${dec.filter((x) => x.worth).length}`,
    trivial_skipped: `${dec.filter((x) => !x.worth && !x.requested).length}/${dec.filter((x) => !x.worth).length}`,
    requests_landed_on_task: `${dec.filter((x) => x.landed_on_task).length}/${dec.filter((x) => x.requested).length}`,
    recall_empty_memory: `${res.recall.filter((x) => !x.lesson_in_memory && x.passed === x.total).length}/3 perfect`,
    recall_lesson_in_memory: `${res.recall.filter((x) => x.lesson_in_memory && x.passed === x.total).length}/3 perfect`,
    total_cost: +[...dec, ...res.recall].reduce((s, x) => s + x.cost, 0).toFixed(4),
  };
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res.summary, null, 1));
})();
