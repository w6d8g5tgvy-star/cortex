'use strict';
// Standby host (2.2): a paired computer keeps a copy of the main vault, serves it while the main computer is off,
// and hands its changes back when the main computer returns. Edits made in both places keep both versions.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const sb = require('../src/standby');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-'));
  // ---------- unit: copy, delete, secrets stay home, conflicts keep both ----------
  const a = path.join(T, 'a'); const b = path.join(T, 'b');
  fs.mkdirSync(path.join(a, 'notes'), { recursive: true }); fs.mkdirSync(path.join(a, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(a, 'notes', 'one.md'), 'one'); fs.writeFileSync(path.join(a, 'notes', 'two.md'), 'two');
  fs.writeFileSync(path.join(a, '.cortex', 'devices.json'), '{"keys":"secret"}'); fs.writeFileSync(path.join(a, '.cortex', 'activity.jsonl'), '{}\n');
  sb.applyChanges(b, sb.changes(a, sb.index(b)));
  assert.equal(fs.readFileSync(path.join(b, 'notes', 'one.md'), 'utf8'), 'one');
  assert.ok(!fs.existsSync(path.join(b, '.cortex', 'devices.json')), 'keys and pairings are never copied');
  assert.ok(fs.existsSync(path.join(b, '.cortex', 'activity.jsonl')), 'the activity log is copied');
  fs.rmSync(path.join(a, 'notes', 'two.md'));
  assert.equal(sb.changes(a, sb.index(b)).files.length, 0, 'unchanged files are not sent again');
  sb.applyChanges(b, sb.changes(a, sb.index(b)));
  assert.ok(!fs.existsSync(path.join(b, 'notes', 'two.md')), 'deletions follow');
  const big = sb.changes(a, {}, { maxBytes: 1 }); assert.ok(big.more && big.files.length === 1, 'large syncs are chunked');
  assert.equal(sb.safe('../x'), null); assert.equal(sb.safe('.cortex/devices.json'), null); assert.equal(sb.safe('/etc/passwd'), null);
  const baseline = sb.index(a);
  await sleep(20); fs.writeFileSync(path.join(a, 'notes', 'one.md'), 'one, edited at home');
  const r = sb.importChanges(a, [{ path: 'notes/one.md', data: Buffer.from('one, edited on standby').toString('base64') }, { path: 'notes/new.md', data: Buffer.from('new').toString('base64') }, { path: '../escape.md', data: 'eA==' }], { baseline, device: 'Laptop' });
  assert.deepEqual(r.written, ['notes/new.md']);
  assert.equal(r.conflicts[0].savedAs, 'notes/one (from Laptop).md');
  assert.equal(fs.readFileSync(path.join(a, 'notes', 'one.md'), 'utf8'), 'one, edited at home');
  assert.equal(fs.readFileSync(path.join(a, 'notes', 'one (from Laptop).md'), 'utf8'), 'one, edited on standby');
  assert.ok(!fs.existsSync(path.join(T, 'escape.md')));
  ok('copy: changed files only, deletions follow, chunked; keys/pairings stay home; edits in both places keep both versions');

  // ---------- end to end: main on → copy; main off → standby serves; main back → hand back ----------
  if (!lanIp) { console.log('  (no LAN address: skipping server checks)'); }
  else {
    const vault = path.join(T, 'main'); const { Store } = require('../src/store'); const st = new Store(vault);
    fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true }); fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ remote: { enabled: true, token: 'legacy-token-123' } }));
    st.create('project', { title: 'Shop' }); const note = st.create('note', { title: 'Plan', body: 'v1', project: 'shop' }); note.path = note.id + '.md';
    const port = 41000 + Math.floor(Math.random() * 1000); const sport = port + 1000;
    const startMain = () => spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', vault, '--port', String(port)], { stdio: 'ignore' });
    const up = async (u) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/api/state')).ok) return true; } catch { /* starting */ } await sleep(250); } return false; };
    let main = startMain(); const base = `http://127.0.0.1:${port}`; const remote = `http://${lanIp}:${port}`;
    await up(base);
    process.env.CORTEX_RUNNER_HOME = path.join(T, 'runner');
    const rc = require('../src/runner-client');
    const quiet = () => {};
    try {
      const cc = await (await fetch(base + '/api/devices/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'computer' }) })).json();
      const conf = await rc.pair({ hub: remote, code: cc.code, name: 'Laptop', folders: [T] });
      const phoneish = await fetch(remote + '/api/runner/vault-changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(phoneish.status, 401, 'only a paired computer can copy the vault');
      const once = (o = {}) => rc.start({ once: true, standby: true, takeoverMinutes: 0, port: sport, ...o }, quiet);
      await once();
      const copy = rc.SB.vault;
      assert.ok(fs.readFileSync(path.join(copy, note.path), 'utf8').includes('v1'), 'standby copy made while the main computer is on');
      assert.ok(!fs.existsSync(path.join(copy, '.cortex', 'settings.json')) && !fs.existsSync(path.join(copy, '.cortex', 'devices.json')));
      ok('standby: a paired computer keeps a copy of the main Cortex (computer keys only, no settings or keys copied)');

      main.kill(); await sleep(500);
      await once();
      assert.ok(rc.SB.child, 'takes over when the main computer is unreachable');
      const sbase = `http://127.0.0.1:${sport}`; assert.ok(await up(sbase), 'standby Cortex serves the copy');
      const sst = await (await fetch(sbase + '/api/standby')).json(); assert.ok(sst.standby && sst.standby.active && sst.standby.device === 'Laptop');
      const items = JSON.stringify(await (await fetch(sbase + '/api/state')).json()); assert.ok(items.includes('Plan'), 'your notes and projects are there');
      await sleep(30);
      const made = await fetch(sbase + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'task', title: 'Written while home PC was off', project: 'shop' }) });
      assert.ok(made.status < 300, 'can work on the standby copy');
      // the same note is changed on both sides
      fs.writeFileSync(path.join(copy, note.path), fs.readFileSync(path.join(copy, note.path), 'utf8').replace('v1', 'v2 standby'));
      ok('standby: when the main computer goes off, this computer serves Cortex with a "standby copy" banner');

      fs.writeFileSync(path.join(vault, note.path), fs.readFileSync(path.join(vault, note.path), 'utf8').replace('v1', 'v2 home'));
      main = startMain(); await up(base);
      await once();
      assert.ok(!rc.SB.child, 'standby stops serving when the main computer is back');
      const st2 = new Store(vault);
      assert.ok(st2.list('task').some((t) => t.title === 'Written while home PC was off'), 'work done on standby is handed back');
      assert.ok(fs.readFileSync(path.join(vault, note.path), 'utf8').includes('v2 home'), 'home edit kept');
      const conflictFile = fs.readdirSync(path.join(vault, path.dirname(note.path))).find((f) => f.includes('(from Laptop)'));
      assert.ok(conflictFile && fs.readFileSync(path.join(vault, path.dirname(note.path), conflictFile), 'utf8').includes('v2 standby'), 'standby edit kept next to it');
      assert.ok(fs.readFileSync(path.join(vault, '.cortex', 'activity.jsonl'), 'utf8').includes('standby.handback'), 'the handback is in the activity log');
      ok('standby: when the main computer returns, the changes are handed back (both versions kept on conflict) and the copy goes passive');
    } finally { rc._stopStandby(); main.kill(); await sleep(300); fs.rmSync(T, { recursive: true, force: true }); }
  }
  console.log(`All ${passed} standby checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
