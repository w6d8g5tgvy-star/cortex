'use strict';
// Multi-agent orchestration (#11), undo (#29), recovery detection (#22), search everywhere (#24).
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const O = require('../src/orchestra');
const U = require('../src/undo');
const sessions = require('../src/sessions');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const v = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-')); const st = new Store(v);
st.create('project', { title: 'Shop' });
const mcp = require('../src/mcp').createMcp(st); const tool = (n) => mcp.tools.find((t) => t.name === n);

// ---------- dependencies + claiming + one task at a time ----------
const a = tool('task_create').run({ title: 'Design the API', project: 'shop', priority: 'high' }, { agent: 'claude-code' });
const b = tool('task_create').run({ title: 'Build the API', project: 'shop', priority: 'urgent', depends_on: a.id, verify: true }, { agent: 'claude-code' });
let n = tool('next_task').run({ project: 'shop' }, { agent: 'claude-code' });
assert.equal(n.task.id, a.id, 'the urgent task waits for its dependency, so the design task comes first');
assert.equal(st.get(a.id).meta.assignee, 'claude-code');
assert.throws(() => tool('task_claim').run({ id: a.id }, { agent: 'codex' }), /owned by claude-code/);
assert.throws(() => tool('task_claim').run({ id: b.id }, { agent: 'codex' }), /waiting on/);
assert.ok(require('../src/brief').buildBrief(st, { task: b.id }).text.includes('Waiting on: Design the API'));
const n2 = tool('next_task').run({ project: 'shop' }, { agent: 'codex' });
assert.equal(n2.task, null, 'codex gets nothing: the only free task is taken, the other is waiting');
ok('dependencies decide the order; claimed tasks can\'t be taken by another active agent; one task at a time');

// ---------- recovery when an agent goes quiet ----------
st.activity.forEach((e) => { if (e.agent === 'claude-code') e.ts = new Date(Date.now() - 3 * 3600e3).toISOString(); });
const n3 = tool('next_task').run({ project: 'shop' }, { agent: 'codex' });
assert.equal(n3.task.id, a.id); assert.ok(n3.task.takeover);
assert.equal(st.get(a.id).meta.assignee, 'codex'); assert.ok(st.get(a.id).body.includes('handed over from claude-code'));
ok('a task whose agent has been silent for 2+ hours is handed over, with a note');

// ---------- independent verification ----------
tool('task_update').run({ id: a.id, status: 'done', append_note: 'Designed; npm test: 12 passing.' }, { agent: 'codex' });
const n4 = tool('next_task').run({ project: 'shop' }, { agent: 'codex' });
assert.equal(n4.task.id, b.id, 'dependency done → the build task is free');
tool('task_update').run({ id: b.id, status: 'done', append_note: 'Built; npm test: 40 passing.' }, { agent: 'codex' });
const vt = st.list('task').find((t) => t.meta.verifies === b.id);
assert.ok(vt && st.get(b.id).meta.verified === 'pending');
assert.throws(() => tool('task_verify').run({ id: vt.id, passed: true }, { agent: 'openai-mcp Codex' }), /different kind of agent/);
tool('task_verify').run({ id: b.id, passed: false, notes: 'POST /orders returns 500' }, { agent: 'claude-code' });
assert.equal(st.get(b.id).meta.status, 'doing'); assert.ok(st.get(b.id).body.includes('Verification FAILED'));
ok('work marked "needs verification" is checked by a different kind of agent; a failed check reopens it');

// ---------- undo ----------
const t = st.create('task', { title: 'Write docs', project: 'shop', body: 'v1' });
st.update(t.id, { body: 'v2 by an agent', status: 'doing' });
st.remove(t.id);
let items = U.list(v);
assert.ok(items[0].summary.startsWith('Deleted task'));
U.undo(st, items[0].id); assert.ok(st.get(t.id), 'delete undone');
U.undo(st, U.list(v).find((e) => e.summary.startsWith('Edited task "Write docs"')).id);
assert.equal(st.get(t.id).body.trim(), 'v1'); assert.equal(st.get(t.id).meta.status, 'todo');
const settings = require('../src/settings'); const s0 = settings.load(v);
settings.save(v, { ...s0, ui: { mode: 'simple', hidePanels: [] } });
U.undo(st, U.list(v).find((e) => e.kind === 'settings').id);
assert.equal(settings.load(v).ui.mode, s0.ui.mode, 'settings change undone');
const c = st.create('note', { title: 'Scratch', body: 'x' }); U.undo(st, U.list(v).find((e) => e.op === 'create' && e.itemId === c.id).id);
assert.equal(st.get(c.id), null, 'a creation can be undone');
assert.throws(() => U.undo(st, 'u-nope'), /Nothing to undo/);
assert.ok(U.CANNOT.length >= 3);
ok('undo restores edited, deleted and created tasks/memories and settings exactly; what can\'t be undone is listed');

// ---------- recovery detection ----------
sessions.upsert(v, 'cc-x', { agent: 'claude-code', project: 'shop', status: 'error', step: 'You\'ve hit your 5-hour limit · resets 4pm' });
const rec = O.recoverable(st, v);
assert.equal(rec[0].project, 'shop'); assert.match(rec[0].why, /limit/);
ok('work stopped by a limit or error in the last day is offered for one-click continuation');

// ---------- search everywhere ----------
st.create('note', { title: 'Decision: use Stripe for payments', type: 'decision', project: 'shop', body: 'We chose Stripe.' });
st.create('skill', { title: 'Stripe webhooks', description: 'Handle Stripe webhooks safely', body: 'Verify signatures.' });
st.log({ agent: 'codex', action: 'agent.start', summary: 'Started: add Stripe checkout', project: 'shop' });
sessions.upsert(v, 'cc-y', { agent: 'claude-code', title: 'Stripe refunds', project: 'shop', status: 'done' });
const r = O.searchAll(st, v, 'stripe');
assert.ok(r.decisions.length && r.skills.length && r.activity.length && r.conversations.length, JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x.length]))));
ok('one search finds decisions, skills, agent activity and conversations (plus projects, tasks, memories, research, saved files)');
fs.rmSync(v, { recursive: true, force: true });
console.log(`All ${passed} orchestration/undo/search checks passed.`);
