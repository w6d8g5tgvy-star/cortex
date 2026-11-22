'use strict';
// Automatic troubleshooting (2.2 #25): detects problems, explains them, and one-click fixes work.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-')); const vault = path.join(T, 'v'); const home = path.join(T, 'home');
  fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const fake = path.join(T, 'claude'); fs.writeFileSync(fake, '#!/bin/sh\necho 2.0\n', { mode: 0o755 });
  const blocked = path.join(T, 'not-a-dir'); fs.writeFileSync(blocked, 'x'); // a "folder" target that is a file: uploads fail
  fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ agents: { enabled: true, folders: [path.join(T, 'gone')] }, smartsave: { enabled: true, projects: {}, targets: [{ id: 'bad', type: 'folder', name: 'USB', dir: blocked }] } }));
  require('../src/devices').redeem(vault, require('../src/devices').createCode(vault, { kind: 'computer', name: 'Laptop' }).code, {});
  const d0 = JSON.parse(fs.readFileSync(path.join(vault, '.cortex', 'devices.json'), 'utf8')); d0.devices[0].lastSeen = '2026-01-01T00:00:00Z'; fs.writeFileSync(path.join(vault, '.cortex', 'devices.json'), JSON.stringify(d0));
  const st = JSON.parse('{"projects":{},"queue":[{"target":"bad","ws":"x","id":"y"}],"targets":{"bad":{"lastError":"EEXIST: file already exists","failures":3,"nextTry":9999999999999}}}');
  fs.mkdirSync(path.join(vault, '.cortex', 'smartsave'), { recursive: true }); fs.writeFileSync(path.join(vault, '.cortex', 'smartsave', 'state.json'), JSON.stringify(st));
  const port = 42000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', vault, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, HOME: home, USERPROFILE: home, CORTEX_CLAUDE_BIN: fake } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    // the server repairs missing hooks on startup only if they were installed before; make sure they're absent now
    const sf = path.join(home, '.claude', 'settings.json'); if (fs.existsSync(sf)) fs.rmSync(sf);
    const d = await (await fetch(base + '/api/doctor')).json();
    const bad = Object.fromEntries(d.checks.filter((c) => !c.ok).map((c) => [c.id, c]));
    assert.ok(bad.hooks && bad.hooks.fix.action === 'hooks.repair', JSON.stringify(Object.keys(bad)));
    assert.ok(bad['agent-folder'] && /allow/i.test(bad['agent-folder'].explain));
    assert.ok(bad['backup-bad'] && bad['backup-bad'].fix.action === 'smartsave.retry');
    assert.ok(Object.keys(bad).some((k) => k.startsWith('device-')), 'offline computer reported');
    assert.ok(d.checks.find((c) => c.id === 'vault-write').ok && d.checks.find((c) => c.id === 'agent-tools').ok);
    ok(`detects missing hooks, a missing agent folder, a failing backup and an offline computer, each with a plain explanation (${d.checks.length} checks)`);
    const r = await (await fetch(base + '/api/doctor/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'hooks.repair' }) })).json();
    assert.ok(r.done);
    const d2 = await (await fetch(base + '/api/doctor')).json();
    assert.ok(d2.checks.find((c) => c.id === 'hooks').ok, 'fixed');
    assert.ok(fs.readFileSync(sf, 'utf8').includes('cortex.js'), 'hooks written to (test) Claude settings');
    const r2 = await (await fetch(base + '/api/doctor/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'smartsave.retry' }) })).json();
    assert.ok(r2.done);
    const c = await (await fetch(base + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'my phone can\'t connect, fix it' }) })).json();
    assert.ok(c.doctor && /problem/.test(c.note));
    ok('one-click fixes work (hooks re-installed, uploads retried) and "fix it" in the command box runs the health check');
  } finally { srv.kill(); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} troubleshooting checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
