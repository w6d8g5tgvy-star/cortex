'use strict';
// Cortex 2.2 intelligence foundation: failure database, improvements (test → apply → rollback), model routing,
// performance profiles, quality checks, notifications, command center. No AI calls.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const I = require('../src/intel');
const notify = require('../src/notify');
const nl = require('../src/nlcmd');
const journal = require('../src/journal');
const sessions = require('../src/sessions');

let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-intel-'));

(async () => {
  const vault = path.join(T, 'v'); const store = new Store(vault); store.create('project', { title: 'Shop' });

  // ---------- failure database ----------
  const f1 = I.failures.record(vault, { task: 'Run the checkout tests', cause: 'Tests failed: ApplePay is not defined. Token sk-ant-' + 'x'.repeat(40), fix: 'Mock window.ApplePaySession in setupTests.ts', project: 'shop', model: 'claude-sonnet-5-5' });
  assert.equal(f1.type, 'test-failure');
  assert.ok(!JSON.stringify(I.failures.all(vault)).includes('sk-ant-x'), 'secrets are redacted');
  const f2 = I.failures.record(vault, { task: 'Run checkout tests again', cause: 'tests failed, ApplePay not defined', project: 'shop', model: 'claude-haiku-5-5' });
  assert.ok(f2.merged); assert.equal(I.failures.all(vault).length, 1); assert.equal(I.failures.all(vault)[0].count, 2);
  I.failures.record(vault, { task: 'Deploy to staging', cause: 'permission denied for the bucket', project: 'shop' });
  const hits = I.failures.lookup(vault, 'fix the failing checkout tests', { project: 'shop' });
  assert.equal(hits.length, 1); assert.ok(hits[0].fix.includes('ApplePaySession'));
  assert.equal(I.failures.lookup(vault, 'write a blog post about cats').length, 0, 'unrelated tasks get nothing');
  // free mining from journals and blocked tasks
  journal.session(vault, 'shop', { agent: 'claude-code', title: 'Add Stripe webhooks', files: ['webhook.ts'], outcome: 'Build failed: cannot find module stripe' });
  journal.session(vault, 'shop', { agent: 'claude-code', title: 'Fix Stripe webhooks build', files: ['webhook.ts', 'package.json'], outcome: 'Fixed by running npm install stripe; build passes.' });
  store.create('task', { title: 'Connect to the warehouse API', project: 'shop', status: 'blocked', body: 'Waiting: API key expired, 401 unauthorized.' });
  store.scan(false);
  const mined = I.failures.mine(store);
  assert.ok(mined.added >= 2, JSON.stringify(mined));
  assert.equal(I.failures.mine(store).added, 0, 'mining is idempotent');
  assert.ok(I.failures.all(vault).some((f) => f.type === 'dependency' && /npm install stripe/.test(f.fix)));
  assert.ok(I.failures.all(vault).some((f) => f.type === 'auth'));
  const t = store.create('task', { title: 'Fix the checkout tests', project: 'shop', body: 'The ApplePay checkout tests fail in CI.' });
  const b = require('../src/brief').buildBrief(store, { task: t.id }).text;
  assert.ok(b.includes('Known pitfalls') && b.includes('ApplePaySession'));
  ok('failure database: classifies, merges repeats, redacts secrets, mines journals/blocked tasks for free, and shows pitfalls in briefs');

  // ---------- improvements: propose → test → apply → measure → rollback ----------
  for (let i = 0; i < 2; i++) I.failures.record(vault, { task: 'Run the checkout tests', cause: 'Tests failed: ApplePay is not defined', project: 'shop' });
  const props = I.engine.proposeFromFailures(store);
  const imp = props.find((x) => /test-failure/.test(x.title));
  assert.ok(imp && imp.status === 'proposed' && imp.baseline && imp.higherIsBetter === false);
  assert.throws(() => I.engine.apply(store, imp.id), /Only verified/);
  assert.equal(I.engine.test(vault, imp.id, { value: 0.5, n: 2 }).status, 'testing', 'too few trials is not proof');
  assert.equal(I.engine.test(vault, imp.id, { value: imp.baseline.value + 0.2, n: 5 }).status, 'rejected', 'worse than baseline is rejected');
  const imp2 = I.engine.propose(vault, { title: 'Run tests before reporting done', kind: 'instruction', project: 'shop', change: 'Always run the test suite and paste the result before marking a task done.', baseline: { metric: 'test-failure failure rate', value: 0.6, n: 10 }, higherIsBetter: false });
  assert.equal(I.engine.test(vault, imp2.id, { value: 0.2, n: 5 }).status, 'verified');
  I.engine.apply(store, imp2.id);
  assert.ok(store.get('projects/shop').meta.instructions.includes('Always run the test suite'));
  // measured afterwards: 5 sessions, all failing tests → worse than baseline → rolled back automatically
  const appliedAt = I.engine.get(vault, imp2.id).appliedAt;
  for (let i = 0; i < 5; i++) journal.session(vault, 'shop', { agent: 'claude-code', title: `Checkout work ${i}`, files: ['a.ts'], outcome: 'Tests failed again: 3 failing' });
  store.scan(false);
  const all = I.engine.all(vault); all.find((x) => x.id === imp2.id).appliedAt = new Date(Date.parse(appliedAt) - 60000).toISOString(); I.engine.save(vault, all);
  const ev = I.engine.evaluate(store);
  assert.ok(ev.some((x) => x.id === imp2.id && x.rolledBack), JSON.stringify(ev));
  assert.ok(!String(store.get('projects/shop').meta.instructions || '').includes('Always run the test suite'), 'rollback removed exactly its own block');
  assert.equal(I.engine.get(vault, imp2.id).status, 'rolled-back');
  assert.ok(I.engine.get(vault, imp2.id).history.length >= 4, 'full history kept');
  ok('improvements: only tested winners apply; too few trials or worse results are rejected; a change that hurts is rolled back automatically');

  // ---------- routing ----------
  const low = I.router.route(store, { prompt: 'Fix a typo in the README' });
  const high = I.router.route(store, { prompt: 'Refactor the payment architecture and debug the race condition in checkout.js cart.js pay.js api.js' });
  assert.equal(low.model, 'haiku'); assert.equal(high.model, 'opus'); assert.ok(high.reasons.length >= 2);
  assert.equal(I.router.route(store, { prompt: 'x', model: 'claude-sonnet-5-5' }).manual, true, 'a manual choice always wins');
  for (let i = 0; i < 6; i++) sessions.upsert(vault, `s${i}`, { agent: 'claude-code', tool: 'claude', model: 'claude-sonnet-5-5', status: 'done', step: 'Finished', cost_usd: 0.05, turns: 4, usage: { input: 1000, output: 300 } });
  const mid = I.router.route(store, { prompt: 'Refactor the settings module and add tests for the new validation rules in settings.js' });
  assert.equal(mid.model, 'sonnet', 'history: sonnet succeeded 6/6, so the cheaper model is used instead of opus: ' + JSON.stringify(mid));
  ok('routing: small tasks → cheap model, hard ones → strong model, cheaper when history proves it is enough, manual choices always win');

  // ---------- profiles ----------
  sessions.upsert(vault, 'e1', { agent: 'codex', tool: 'codex', model: 'gpt-6.2', status: 'error', step: 'You hit your usage limit' });
  const prof = I.profiles(store);
  const sonnet = prof.find((p) => /sonnet/.test(p.agent));
  assert.equal(sonnet.successRate.value, 1); assert.equal(sonnet.successRate.n, 6); assert.equal(sonnet.avgCost.source, 'measured');
  const codex = prof.find((p) => /codex/.test(p.agent));
  assert.equal(codex.successRate.value, 0); assert.equal(codex.avgCost.source, 'unavailable');
  assert.equal(codex.codingAccuracy.source, 'unavailable');
  ok('performance profiles: measured numbers carry sample sizes; missing data is shown as unavailable, never estimated');

  // ---------- quality checks ----------
  const qt = store.create('task', { title: 'Add Apple Pay button', project: 'shop', body: 'Deliverables: button, tests\n- [x] button\n- [ ] tests' });
  const q1 = I.qaCheck(store, qt, { outcome: 'Done, added the button.' });
  assert.equal(q1.verdict, 'fail');
  store.update(qt.id, { body: 'Deliverables: button, tests\n- [x] button\n- [x] tests' });
  const q2 = I.qaCheck(store, store.get(qt.id), { outcome: 'Added the button and tests; npm test: 42 passing.' });
  assert.equal(q2.verdict, 'pass', JSON.stringify(q2.checks));
  const q3 = I.qaCheck(store, store.get(qt.id), { outcome: 'Added the button and tests.' });
  assert.equal(q3.verdict, 'warn', 'missing test evidence is a warning');
  // an agent marking a task done triggers the check (MCP)
  const mcp = require('../src/mcp').createMcp(store);
  const tu = mcp.tools.find((x) => x.name === 'task_update');
  const qt2 = store.create('task', { title: 'Fix login redirect bug', project: 'shop', body: '- [ ] redirect works\n- [ ] tests' });
  tu.run({ id: qt2.id, status: 'done', append_note: 'All done!' }, { agent: 'claude-code' });
  const after = store.get(qt2.id);
  assert.ok(String(after.meta.qa).startsWith('fail'), 'claims are not proof: ' + after.meta.qa);
  assert.ok(after.body.includes('Cortex quality check: FAIL'));
  ok('quality checks: unchecked criteria, failures in the summary and missing test evidence are caught when an agent marks work done');

  // ---------- notifications ----------
  const nv = path.join(T, 'nv'); fs.mkdirSync(path.join(nv, '.cortex'), { recursive: true });
  notify.add(nv, { kind: 'failed', title: 'Job failed', ref: 'job-1' }, {});
  notify.add(nv, { kind: 'failed', title: 'Job failed', ref: 'job-1' }, {});
  notify.add(nv, { kind: 'approval', title: 'Codex wants to start', ref: 'job-2' }, {});
  assert.equal(notify.list(nv).length, 2); assert.equal(notify.list(nv).find((n) => n.ref === 'job-1').count, 2);
  assert.equal(notify.add(nv, { kind: 'research', title: 'x' }, { notifications: { off: ['research'] } }), null, 'kinds can be turned off');
  assert.equal(notify.markRead(nv, 'all').unread, 0);
  assert.ok(require('../src/notify').list(vault).some((n) => n.kind === 'qa'), 'the failed quality check notified the user');
  ok('notifications: repeats are grouped (×2), kinds can be turned off, read state is kept');

  // ---------- command parsing ----------
  const ps = [{ title: 'Shop', slug: 'shop' }];
  const cases = { 'start a project called Website': 'create-project', 'continue my work on Shop': 'continue', 'research faster test runs': 'research', 'launch an agent to fix the login bug': 'launch', 'connect my phone': 'connect-device', 'my connector is not working, fix it': 'troubleshoot', 'find apple pay': 'search', 'turn on phone access': 'setting', 'stop all agents': 'emergency-stop', 'save every 5 minutes': 'setting', 'make my AI agents better': 'improve', 'organize my notes': 'organize', 'switch to simple mode': 'ui-mode', 'what is the weather': 'unknown' };
  for (const [q, want] of Object.entries(cases)) assert.equal(nl.parse(q, { projects: ps }).intent, want, q);
  for (const q of ['turn on phone access', 'stop all agents', 'launch an agent to fix it', 'research x']) assert.ok(nl.parse(q, { projects: ps }).confirm, `"${q}" needs confirmation`);
  ok(`command center understands ${Object.keys(cases).length} kinds of requests; settings, launches, research and stops always ask first`);

  // ---------- real server: command center + emergency stop + intelligence data ----------
  const sv = path.join(T, 'sv'); const work = path.join(T, 'work'); fs.mkdirSync(work, { recursive: true });
  const fake = path.join(T, 'slow-claude'); fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdin.resume();setTimeout(()=>{},60000);\n', { mode: 0o755 });
  fs.mkdirSync(path.join(sv, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(sv, '.cortex', 'settings.json'), JSON.stringify({ agents: { enabled: true, folders: [work] } }));
  const port = 43000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', sv, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, CORTEX_CLAUDE_BIN: fake } });
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    const c1 = await post('/api/command', { text: 'start a project called Website' });
    assert.ok(c1.done && c1.go === '#/projects/website');
    const c2 = await post('/api/command', { text: 'turn on phone access' });
    assert.ok(c2.needsConfirm && !c2.done, 'settings are proposed first');
    const before = await (await fetch(base + '/api/settings')).json();
    assert.equal(before.remote.enabled, false);
    const c3 = await post('/api/command', { text: 'turn on phone access', confirm: true });
    assert.ok(c3.done);
    assert.equal((await (await fetch(base + '/api/settings')).json()).remote.enabled, true);
    const c4 = await post('/api/command', { text: 'launch an agent to tidy the readme in website', confirm: true });
    assert.ok(c4.job && c4.route && c4.route.model === 'haiku', JSON.stringify(c4));
    await sleep(800);
    const live = await post('/api/emergency-stop');
    assert.ok(live.runs + live.jobs >= 1, JSON.stringify(live));
    const jobs = (await (await fetch(base + '/api/jobs')).json()).jobs;
    assert.ok(jobs.every((j) => !['queued', 'running'].includes(j.status) || j.stopRequested), JSON.stringify(jobs.map((j) => j.status)));
    const intel = await (await fetch(base + '/api/intel')).json();
    assert.ok(Array.isArray(intel.profiles) && intel.routing.settings.mode === 'suggest');
    const nn = await (await fetch(base + '/api/notifications')).json();
    assert.ok(typeof nn.unread === 'number');
    ok('server: commands run, settings change only after confirming, launches are routed, the emergency stop halts running work');
  } finally { srv.kill(); }

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`All ${passed} intelligence checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
