'use strict';
// Timeline filters (#36), feedback → proposals (#39), learned preferences you can forget (#14), shortcuts (#37).
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const up = require('../src/userprefs');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'up-')); const st = new Store(v);
  st.log({ agent: 'you', action: 'task.update', summary: 'Moved "Login" → done', project: 'shop' });
  st.log({ agent: 'claude-code', action: 'agent.start', summary: 'Started Claude Code on this computer: fix login', project: 'shop', device: 'This computer' });
  st.log({ agent: 'claude-code', action: 'job.failed', summary: 'Ended (error) on Laptop: deploy', project: 'site', device: 'Laptop' });
  st.log({ agent: 'cortex', action: 'smartsave.checkpoint', summary: 'SmartSave: saved shop', project: 'shop' });
  st.log({ agent: 'you (phone)', action: 'memory.write', summary: 'Saved memory "Prefs"', project: 'shop' });
  assert.equal(up.timeline(st, { project: 'shop' }).items.length, 4);
  assert.equal(up.timeline(st, { device: 'Laptop' }).items.length, 1);
  assert.equal(up.timeline(st, { type: 'saves' }).items[0].action, 'smartsave.checkpoint');
  assert.equal(up.timeline(st, { agent: 'claude-code' }).items.find((e) => e.action === 'job.failed').result, 'problem');
  assert.equal(up.timeline(st, { q: 'deploy' }).items.length, 1);
  assert.ok(up.timeline(st).filters.devices.includes('Laptop'));
  ok('timeline filters by project, agent, device, event type and text; failures are marked');

  const s = { ui: { mode: 'simple', hidePanels: [] }, routing: { mode: 'auto' }, preferences: { forgotten: [] } };
  st.create('note', { title: 'Working style: short replies', body: 'I prefer short replies.', tags: ['preferences'] });
  for (let i = 0; i < 25; i++) st.log({ agent: i % 5 ? 'you' : 'you (phone)', action: 'task.update', summary: 'x', project: 'shop' });
  let p = up.preferences(st, s);
  assert.ok(p.explicit.some((n) => /Working style/.test(n.title)));
  assert.ok(p.learned.find((l) => l.key === 'top-projects').value.startsWith('shop'));
  assert.ok(p.learned.find((l) => l.key === 'interface').value.includes('simple mode'));
  p = up.preferences(st, { ...s, preferences: { forgotten: ['top-projects'] } });
  assert.ok(!p.learned.some((l) => l.key === 'top-projects'), 'forgotten items disappear');
  ok('learned preferences come only from Cortex use, are labelled with their source, and can be forgotten');

  let r;
  for (let i = 0; i < 3; i++) r = up.addFeedback(st, { about: 'agent results', rating: 'down', text: i === 2 ? 'skipped the tests, key sk-ant-' + 'x'.repeat(40) : 'wrong file' });
  assert.ok(r.proposal && r.proposal.status === 'proposed' && r.proposal.baseline.metric === 'thumbs-down share');
  assert.ok(!JSON.stringify(up.listFeedback(v)).includes('sk-ant-x'), 'secrets in feedback are redacted');
  assert.throws(() => up.addFeedback(st, {}), /thumbs/);
  ok('three thumbs-down about the same thing become an improvement proposal (to be tested); feedback is optional and redacted');

  const port = 41000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`; const post = async (pp, b) => (await fetch(base + pp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    await post('/api/shortcuts', { name: 'Save shop', text: 'save shop' });
    await post('/api/shortcuts', { name: 'Morning', text: 'continue my work on shop' });
    let sc = (await (await fetch(base + '/api/shortcuts')).json()).shortcuts;
    assert.deepEqual(sc.map((x) => x.name), ['Save shop', 'Morning']);
    sc = (await post('/api/shortcuts', { remove: 'Save shop' })).shortcuts; assert.deepEqual(sc.map((x) => x.name), ['Morning']);
    await post('/api/preferences/forget', { key: 'models' });
    assert.ok((await (await fetch(base + '/api/preferences')).json()).forgotten.includes('models'));
    const tl = await (await fetch(base + '/api/timeline?type=tasks')).json(); assert.ok(tl.items.every((e) => e.type === 'tasks'));
    ok('server: shortcuts can be saved and removed, preferences forgotten, timeline filtered');
  } finally { srv.kill(); fs.rmSync(v, { recursive: true, force: true }); }
  console.log(`All ${passed} timeline/feedback/preferences checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
