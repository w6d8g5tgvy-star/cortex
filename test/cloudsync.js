'use strict';
// Cloud sync: two computers (and a cloud session) share one vault through a private Git repo (a local bare repo
// stands in for GitHub). Changes flow both ways, deletions follow, edits on both sides keep both versions, starter
// notes don't duplicate, .cortex (settings, keys) is never uploaded, passwords in the address are refused.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Store } = require('../src/store');
const cs = require('../src/cloudsync');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')); const remote = path.join(T, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const A = path.join(T, 'A'); const B = path.join(T, 'B');
  let sa = new Store(A); let sb = new Store(B); // both get the starter notes
  fs.mkdirSync(path.join(A, '.cortex'), { recursive: true }); fs.writeFileSync(path.join(A, '.cortex', 'devices.json'), '{"keys":"secret-device-key"}');
  const shared = sa.create('note', { title: 'Shared plan', body: 'v1' });
  const gone = sa.create('note', { title: 'Old idea', body: 'remove me later' });
  const r1 = await cs.sync(A, { remote, device: 'Home PC' }); assert.ok(r1.pushed);
  const r2 = await cs.sync(B, { remote, device: 'Laptop' });
  sb = new Store(B);
  assert.ok(sb.get(shared.id) && sb.get(shared.id).body.includes('v1'), 'the other computer gets the notes');
  assert.ok(!fs.readdirSync(B, { recursive: true }).some((f) => String(f).includes('(from other computer)')), 'starter notes that only differ in timestamps don\'t duplicate: ' + r2.conflicts.map((c) => c.savedAs).join(', '));
  const tracked = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).toString();
  assert.ok(!tracked.includes('.cortex/') && tracked.includes('.gitignore'), '.cortex (settings, keys) is never uploaded');
  ok('first sync: the second computer gets everything; welcome notes don\'t duplicate; settings and keys stay on each computer');

  sb.create('task', { title: 'Made on the laptop' }); sb.remove(gone.id);
  await cs.sync(B, { remote, device: 'Laptop' });
  await cs.sync(A, { remote, device: 'Home PC' }); sa = new Store(A);
  assert.ok(sa.list('task').some((t) => t.title === 'Made on the laptop')); assert.ok(!sa.get(gone.id), 'deletions follow');
  ok('changes and deletions flow between computers');

  sa.update(shared.id, { body: 'v2 from home' }); new Store(B).update(shared.id, { body: 'v2 from laptop' });
  await cs.sync(A, { remote, device: 'Home PC' });
  const rc = await cs.sync(B, { remote, device: 'Laptop' });
  assert.equal(rc.conflicts.length, 1);
  const file = new Store(B).fileOf(shared.id);
  assert.ok(fs.readFileSync(file, 'utf8').includes('v2 from laptop'), 'this computer\'s version stays in place');
  assert.ok(fs.readFileSync(rc.conflicts[0].savedAs.split('/').reduce((p, x) => path.join(p, x), B), 'utf8').includes('v2 from home'), 'the other version is kept next to it');
  await cs.sync(A, { remote, device: 'Home PC' });
  assert.ok(fs.readdirSync(path.dirname(new Store(A).fileOf(shared.id))).some((f) => f.includes('(from other computer)')), 'and both computers end up with both versions');
  ok('edited on both computers: both versions kept, nothing lost');

  // a cloud AI session: just clone the repo
  const C = path.join(T, 'cloud'); execFileSync('git', ['clone', '-q', remote, C]);
  assert.ok(new Store(C).list('task').some((t) => t.title === 'Made on the laptop'), 'a cloud session sees the same Cortex');
  ok('a cloud session can clone the vault and work on the same Cortex');

  assert.throws(() => { if (!cs.validRemote('https://github.com/me/v.git; rm -rf /')) throw new Error('bad'); }, /bad/);
  await assert.rejects(() => cs.ensure(path.join(T, 'D'), { remote: 'not a url' }), /doesn't look right/);
  execFileSync('git', ['init', '-q', path.join(T, 'E')]); execFileSync('git', ['-C', path.join(T, 'E'), 'remote', 'add', 'origin', 'https://github.com/someone/else.git']);
  await assert.rejects(() => cs.ensure(path.join(T, 'E'), { remote }), /already a Git repository linked to/, 'never takes over a repo you linked elsewhere');

  // server: turn on from Settings API, pull a change made on the other computer
  const S2 = path.join(T, 'S'); new Store(S2);
  const port = 45700 + Math.floor(Math.random() * 90);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', S2, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`; const post = async (b) => { const r = await fetch(base + '/api/cloudsync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    assert.equal((await post({ enabled: true, remote: 'https://me:ghp_secret@github.com/me/v.git' })).status, 400, 'a password or token in the address is refused');
    const on = await post({ enabled: true, remote, device: 'Server PC' }); assert.ok(on.j.status.ok, JSON.stringify(on.j));
    const st = await (await fetch(base + '/api/state')).json(); assert.ok(st.tasks.some((t) => t.title === 'Made on the laptop'), 'turning it on brings in the shared Cortex');
    new Store(A).create('note', { title: 'Written at home just now', body: 'hello' }); await cs.sync(A, { remote, device: 'Home PC' });
    await post({ action: 'sync' });
    const st2 = await (await fetch(base + '/api/state')).json(); assert.ok(st2.notes.some((n) => n.title === 'Written at home just now'));
    const g = await (await fetch(base + '/api/cloudsync')).json(); assert.ok(g.enabled && g.status.ok && g.git);
    ok('server: turn on in Settings, it pulls the shared Cortex; Sync now brings in new changes; tokens in the address refused');
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} cloud sync checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
