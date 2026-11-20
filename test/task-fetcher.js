'use strict';
// Fetcher per task: on/off switch, free "is it worth it" advice for agents, requests that show up on the task,
// and approval by the user before anything runs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Fetcher } = require('../src/fetcher');
const { createMcp } = require('../src/mcp');
const tf = require('../src/task-fetcher');
const brief = require('../src/brief');

let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-taskfx-'));
const store = new Store(vault);
store.create('project', { title: 'Shop' });
const hard = store.create('task', { title: 'Find a faster, more efficient way to run our slow end-to-end tests', project: 'shop', body: 'The Playwright suite takes 40 minutes and keeps failing on CI with flaky timeouts. We tried retries; it didn\'t work. Research the best practice for speeding up and stabilising large e2e suites.' });
const tiny = store.create('task', { title: 'Fix typo in README', project: 'shop' });

// --- advice (free) ---
const ah = tf.advice(store, hard);
assert.ok(ah.enabled && ah.recommend, JSON.stringify(ah));
const at = tf.advice(store, tiny);
assert.ok(at.enabled && !at.recommend, JSON.stringify(at));
ok('free advice: recommends Fetcher for a hard "find a better way" task, not for a typo fix');

// --- MCP: agent checks, requests on its task, request shows on the task and waits for the user ---
const mcp = createMcp(store);
const tool = (n) => mcp.tools.find((t) => t.name === n);
const adv = tool('fetcher_advice').run({ task: hard.id }, { agent: 'claude-haiku' });
assert.equal(adv.recommend, true);
const got = tool('task_get').run({ id: hard.id }, {});
assert.ok(got.fetcher && got.fetcher.enabled === true && got.fetcher.recommend === true);
const req = tool('fetcher_request').run({ topic: 'speed up flaky Playwright e2e suites', why: 'suite takes 40 min and flakes', task: hard.id }, { agent: 'claude-haiku' });
assert.equal(req.status, 'needs-approval');
assert.equal(req.task, hard.id);
const f = new Fetcher({ store, runner: null });
assert.equal(f.get(req.id).project, 'shop', 'project comes from the task');
assert.ok(store.get(hard.id).body.includes('Waiting for your OK') && store.get(hard.id).body.includes('speed up flaky Playwright'));
assert.equal(tf.requests(store, hard.id).length, 1);
assert.equal(tf.advice(store, hard).recommend, false, 'a pending request stops duplicate requests');
ok('agents request Fetcher for their task; the request is noted on the task and waits for approval');

// --- brief shows the Fetcher section ---
const b = brief.buildBrief(store, { task: hard.id }).text;
assert.ok(b.includes('Fetcher (research help) for this task') && b.includes('Fetcher for this task: ON') && b.includes(req.id));
ok('the task brief tells the agent whether Fetcher is on, the free recommendation and its requests');

// --- approve / decline from the task ---
f.approve(req.id, { start: false });
assert.equal(f.get(req.id).status, 'queued');
assert.ok(store.get(hard.id).body.includes('You approved'));
const req2 = tool('fetcher_request').run({ topic: 'parallel sharding for e2e tests', task: hard.id }, { agent: 'codex' });
f.reject(req2.id);
assert.ok(store.get(hard.id).body.includes('You declined'));
ok('approving or declining a request is recorded on the task');

// --- switch off ---
store.update(tiny.id, { fetcher: 'off' });
assert.equal(tf.enabled(store.get(tiny.id)), false);
assert.throws(() => tool('fetcher_request').run({ topic: 'readme style', task: tiny.id }, { agent: 'codex' }), /turned off/);
assert.ok(tf.advice(store, store.get(tiny.id)).reasons[0].includes('turned off'));
assert.ok(brief.buildBrief(store, { task: tiny.id }).text.includes('Fetcher for this task: OFF'));
store.update(tiny.id, { fetcher: 'on' });
assert.equal(tf.enabled(store.get(tiny.id)), true);
ok('each task has a Fetcher on/off switch; off refuses requests for that task');

fs.rmSync(vault, { recursive: true, force: true });
console.log(`All ${passed} task Fetcher checks passed.`);
process.exit(0);
