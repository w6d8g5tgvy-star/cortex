'use strict';
// Drag-and-drop uploads (#31), UX metrics (#42), onboarding flag (#40), sandbox API (#12).
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const up = require('../src/uploads');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-')); const v = path.join(T, 'v'); const st = new Store(v); st.create('project', { title: 'Shop' });
  const r = up.save(st, { name: 'notes from call.md', data: Buffer.from('# Call\nUse Stripe.'), project: 'shop' });
  assert.ok(r.path.startsWith('attachments/shop/') && fs.existsSync(path.join(v, r.path)) && r.preview.includes('Use Stripe'));
  assert.ok(st.list('note', { project: 'shop' }).some((n) => n.title === 'File: notes_from_call.md'));
  const t = st.create('task', { title: 'Fix logo', project: 'shop' });
  up.save(st, { name: 'logo.png', data: Buffer.from([137, 80, 78, 71]), project: 'shop', task: t.id });
  assert.ok(st.get(t.id).body.includes('Attached:') && st.get(t.id).body.includes('logo.png'));
  assert.throws(() => up.save(st, { name: 'tool.exe', data: Buffer.from('MZ') }), /aren't accepted/);
  assert.throws(() => up.save(st, { name: 'run.sh', data: Buffer.from('rm -rf') }), /aren't accepted/);
  assert.throws(() => up.save(st, { name: 'conf.json', data: Buffer.from('{"k":"ghp_' + 'a'.repeat(36) + '"}') }), /contains a GitHub token/);
  assert.throws(() => up.save(st, { name: 'big.txt', data: Buffer.alloc(11 * 1024 * 1024, 97) }), /10 MB/);
  const evil = up.save(st, { name: '../../evil.md', data: Buffer.from('x') }); assert.ok(evil.path.startsWith('attachments/inbox/') && !evil.path.includes('..'), 'file names can\'t escape the attachments folder');
  ok('uploads: text/code/images/PDF only, programs and scripts refused, secrets refused, 10 MB limit, safe names; linked from a note or the task');

  up.uxRecord(v, [{ type: 'page', key: '#/home' }, { type: 'click', key: 'cc-panel' }, { type: 'command', ok: false }, { type: 'command', ok: false }, { type: 'command', ok: false }, { type: 'flow-end', key: 'pair-phone', ms: 90000, steps: 9 }, { type: 'secret', key: 'x' }, { type: 'click', key: 'my password is hunter2!' }]);
  const rep = up.uxReport(v);
  assert.ok(rep.measuring && rep.flows['pair-phone'].avgSteps === 9);
  assert.ok(rep.suggestions.some((s) => /9 steps/.test(s)) && rep.suggestions.some((s) => /misunderstood 3/.test(s)) && rep.suggestions.some((s) => /Never used yet/.test(s)));
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(v, '.cortex', 'ux.json'), 'utf8'))).includes('hunter2!') && !fs.readFileSync(path.join(v, '.cortex', 'ux.json'), 'utf8').includes('secret'), 'only ids/counts kept; free text is stripped');
  ok('UX metrics: counts and durations only (typed text stripped), and they turn into concrete suggestions');

  const proj = path.join(T, 'proj'); fs.mkdirSync(proj); fs.writeFileSync(path.join(proj, 'a.js'), '1');
  st.update('projects/shop', { folder: proj });
  const port = 40000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`; const post = async (pp, b, h) => { const x = await fetch(base + pp, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || {}) }, body: typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b) }); return { status: x.status, j: await x.json() }; };
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    const u1 = await post('/api/upload', 'hello from the phone', { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('hello.txt'), 'X-Project': 'shop' });
    assert.equal(u1.status, 201);
    assert.equal((await post('/api/upload', 'MZ', { 'X-Filename': 'x.exe' })).status, 400);
    assert.equal((await post('/api/ux', { events: [{ type: 'page', key: '#/x' }] })).j.measuring, false, 'nothing is measured until the user opts in');
    await post('/api/ux/settings', { measure: true, onboarded: true });
    assert.equal((await post('/api/ux', { events: [{ type: 'page', key: '#/x' }] })).j.ok, true);
    const ux = await (await fetch(base + '/api/ux')).json(); assert.ok(ux.onboarded && ux.measure);
    const sb = await post('/api/sandbox', { action: 'create', project: 'shop' }); assert.equal(sb.status, 201);
    const run = await post('/api/sandbox', { action: 'run', id: sb.j.id, cmd: 'node', args: ['-e', "require('fs').writeFileSync('a.js','2')"] }); assert.equal(run.j.code, 0);
    assert.equal((await post('/api/sandbox', { action: 'run', id: sb.j.id, cmd: 'bash', args: ['-c', 'echo hi'] })).status, 400, 'only allow-listed commands');
    assert.deepEqual((await post('/api/sandbox', { action: 'diff', id: sb.j.id })).j.changed, ['a.js']);
    assert.equal((await post('/api/sandbox', { action: 'apply', id: sb.j.id })).status, 400, 'applying needs approval');
    assert.deepEqual((await post('/api/sandbox', { action: 'apply', id: sb.j.id, approved: true })).j.applied, ['a.js']);
    assert.equal(fs.readFileSync(path.join(proj, 'a.js'), 'utf8'), '2');
    await post('/api/sandbox', { action: 'destroy', id: sb.j.id });
    ok('server: uploads, opt-in UX measuring, onboarding flag, sandbox create/run/diff/apply-with-approval');
  } finally { srv.kill(); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} upload/UX/sandbox checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
