'use strict';
// Sandbox (#12) and prompt library (#13). Uses a stand-in model, so no AI is used or paid for.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const sbx = require('../src/sandbox');
const P = require('../src/prompts');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')); const proj = path.join(T, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1'); fs.writeFileSync(path.join(proj, 'keys.txt'), '-----BEGIN RSA PRIVATE KEY-----\nx');
  fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'i.js'), '');
  // ---------- sandbox ----------
  const s = sbx.create(proj, { name: 'try refactor' });
  assert.ok(fs.existsSync(path.join(s.dir, 'src', 'a.js')) && !fs.existsSync(path.join(s.dir, '.env')) && !fs.existsSync(path.join(s.dir, 'keys.txt')) && !fs.existsSync(path.join(s.dir, 'node_modules')));
  process.env.SUPER_SECRET_TOKEN = 'abc123';
  const r1 = await sbx.run(s.id, process.execPath, ['-e', "require('fs').writeFileSync('src/a.js','module.exports = 2;\\n');require('fs').writeFileSync('src/b.js','x');console.log('token=' + (process.env.SUPER_SECRET_TOKEN || 'none'))"]);
  assert.equal(r1.code, 0); assert.ok(r1.out.includes('token=none'), 'secrets in the environment are not passed in');
  assert.equal(fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8'), 'module.exports = 1;\n', 'the real project is untouched');
  const r2 = await sbx.run(s.id, process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 500 });
  assert.ok(r2.timedOut && r2.ms < 3000, 'time limit enforced');
  const r3 = await sbx.run(s.id, process.execPath, ['-e', "require('http').get('http://example.com',()=>console.log('ONLINE')).on('error',()=>console.log('OFFLINE'))"], { timeoutMs: 5000 });
  assert.ok(!/ONLINE/.test(r3.out) && /best effort/.test(r3.network));
  const d = sbx.diff(s.id);
  assert.deepEqual(d.changed, ['src/a.js']); assert.deepEqual(d.added, ['src/b.js']);
  assert.throws(() => sbx.apply(s.id, {}), /needs your approval/);
  const ap = sbx.apply(s.id, { approved: true, files: ['src/a.js'] });
  assert.deepEqual(ap.applied, ['src/a.js']); assert.equal(fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8'), 'module.exports = 2;\n');
  assert.ok(!fs.existsSync(path.join(proj, 'src', 'b.js')), 'only the approved file was applied');
  assert.ok(fs.existsSync(path.join(proj, '.env')), 'nothing real is ever deleted');
  sbx.destroy(s.id); assert.ok(!fs.existsSync(s.dir));
  ok('sandbox: a copy without secrets or dependencies; clean environment, time limit, network blocked (best effort); only approved changes reach the real project');

  // ---------- prompt library ----------
  const v = path.join(T, 'vault');
  P.addVersion(v, 'Write code', 'Write the function.');
  P.addVersion(v, 'Write code', 'Write the function. List every edge case first and handle each one.', { note: 'edge-case checklist' });
  assert.equal(P.active(v, 'write-code').v, 1);
  const tasks = [{ id: 't1', input: 'sum', score: (t) => ({ passed: /edge/.test(t) ? 5 : 3, total: 5 }) }, { id: 't2', input: 'sort', score: (t) => ({ passed: /edge/.test(t) ? 4 : 4, total: 4 }) }];
  const runner = async (prompt) => ({ text: prompt, tokens: prompt.length * 2, ms: 10, cost: 0.001 });
  const c = await P.compare(v, 'write-code', { tasks, runner, trials: 2 });
  assert.equal(c.promoted, 2); assert.equal(P.active(v, 'write-code').v, 2);
  assert.equal(P.get(v, 'write-code').versions[0].status, 'retired');
  const s2 = c.summary.find((x) => x.v === 2); assert.ok(s2.passRate > c.summary.find((x) => x.v === 1).passRate && s2.avgTokens && s2.completion !== null);
  P.addVersion(v, 'Write code', 'Bad version: just guess.');
  const c2 = await P.compare(v, 'write-code', { versions: [2, 3], tasks, runner, trials: 2 });
  assert.equal(c2.promoted, null, 'a worse version never replaces the active one');
  const c3 = await P.compare(v, 'write-code', { versions: [2, 3], tasks, runner: async (p) => ({ text: p, tokens: 1, ms: 1, cost: 0.2 }), trials: 5, maxCostUsd: 0.5 });
  assert.ok(c3.stoppedAtBudget && c3.spent <= 0.6, 'stops at the spending limit');
  ok('prompt library: versions compared on identical tasks with objective scores (accuracy, completion, tokens, time, cost); winners promoted, losers retired, budget enforced');
  fs.rmSync(T, { recursive: true, force: true });
  console.log(`All ${passed} sandbox/prompt checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
