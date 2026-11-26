'use strict';
// One-file installers (#20): the right file per OS with only a one-time code inside; the download link doesn't use up
// the code; pairing works before Node.js is even installed; the Linux installer runs end to end against a real
// Cortex (download faked with a local copy of this repo); Windows/Mac files are checked for structure.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { Store } = require('../src/store');
const inst = require('../src/installers');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  // ---------- generators ----------
  const w = inst.build('windows', { hub: 'https://home.example.ts.net', code: 'abcd-1234', standby: true }).body.toString();
  assert.ok(w.includes('set "CODE=ABCD-1234"') && w.includes('set "HUB=https://home.example.ts.net"') && w.includes('set "STANDBY=1"'));
  assert.ok(!/token/i.test(w.replace(/runner-config/g, '')), 'no device key inside, only the one-time code');
  for (const label of [...w.matchAll(/goto (\w+)/g)].map((m) => m[1])) assert.ok(w.includes(`\r\n:${label}\r\n`), `goto ${label} has a label`);
  for (const line of w.split('\r\n')) { const o = (line.match(/\(/g) || []).length; const c = (line.match(/\)/g) || []).length; if (!/^REM|^echo/.test(line)) assert.equal(o, c, `balanced parentheses: ${line.slice(0, 80)}`); }
  assert.ok(w.includes('\r\n'), 'Windows line endings');
  const main = inst.build('windows', {}).body.toString(); assert.ok(main.includes('set "MODE=main"') && main.includes('cortex.js" setup'));
  assert.throws(() => inst.build('windows', { code: 'ABCD-1234', hub: 'javascript:alert(1)' }), /address/);
  const evil = inst.build('windows', { code: 'AB"&calc&-12', hub: 'https://x.ts.net' }).body.toString(); assert.ok(!evil.includes('&calc') && evil.includes('set "CODE=ABCALC-12"'), 'nothing can be injected through the code');
  const mz = inst.build('mac', { hub: 'http://192.168.1.5:7777', code: 'WXYZ-9876' });
  assert.equal(mz.type, 'application/zip');
  const zf = path.join(T, 'mac.zip'); fs.writeFileSync(zf, mz.body);
  const listing = execFileSync('unzip', ['-Z', zf]).toString();
  assert.match(listing, /-rwxr-xr-x.*Install Cortex \(connect to main Cortex\)\.command/, 'the Mac installer stays executable inside the zip');
  const ux = path.join(T, 'ux'); execFileSync('unzip', ['-q', zf, '-d', ux]);
  const macScript = path.join(ux, 'Install Cortex (connect to main Cortex).command');
  assert.equal(spawnSync('bash', ['-n', macScript]).status, 0, 'Mac script is valid bash');
  assert.ok(fs.readFileSync(macScript, 'utf8').includes('launchctl load'));
  const lin = inst.build('linux', {}); const lf = path.join(T, 'l.sh'); fs.writeFileSync(lf, lin.body); assert.equal(spawnSync('bash', ['-n', lf]).status, 0);
  const repo = path.join(__dirname, '..', 'installers');
  assert.equal(fs.readFileSync(path.join(repo, 'Install Cortex.cmd'), 'utf8'), inst.build('windows', {}).body.toString(), 'installers/ in the repo match the generator (regenerate them if this fails)');
  assert.equal(fs.readFileSync(path.join(repo, 'install-cortex.sh'), 'utf8'), inst.build('linux', {}).body.toString());
  ok('installers: Windows (.cmd), Mac (.command in a zip, still executable), Linux (.sh); valid scripts; only a one-time code inside; nothing injectable');

  // ---------- `cortex setup` (what the installers and Setup Cortex.bat run) must work ----------
  { const home = path.join(T, 'sethome'); const nb = path.join(T, 'nodeonly'); fs.mkdirSync(nb); fs.symlinkSync(process.execPath, path.join(nb, 'node'));
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'setup', '--vault', path.join(T, 'setv'), '--no-screen', '--no-autostart'], { env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), PATH: nb }, timeout: 60000 });
    const out = r.stdout.toString() + r.stderr.toString();
    assert.equal(r.status, 0, out); assert.match(out, /Cortex setup/); assert.match(out, /Cortex settings/); assert.ok(!/is not a function/.test(out));
    ok('`cortex setup` runs (it was broken when Fetcher 2 replaced src/setup.js; restored as src/appsetup.js)'); }

  // ---------- server ----------
  const v = path.join(T, 'v'); new Store(v);
  fs.mkdirSync(path.join(v, '.cortex'), { recursive: true }); fs.writeFileSync(path.join(v, '.cortex', 'settings.json'), JSON.stringify({ remote: { enabled: true, token: 'tok-abcdefghijk' } }));
  const port = 47900 + Math.floor(Math.random() * 90);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`; const hubUrl = lanIp ? `http://${lanIp}:${port}` : base;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  let runnerPid = null;
  try {
    const page = await fetch(base + '/install'); assert.equal(page.status, 200); assert.match(await page.text(), /Download for Windows/);
    const dl = await fetch(base + '/install/windows'); assert.match(dl.headers.get('content-disposition'), /attachment; filename="Install Cortex\.cmd"/);
    assert.equal((await fetch(base + '/i/ZZZZ-ZZZZ')).status, 400, 'a wrong code shows an error page');
    const phone = await (await fetch(base + '/api/devices/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"phone"}' })).json();
    assert.equal((await fetch(base + '/i/' + phone.code)).status, 400, 'phone codes can\'t make computer installers');
    const cc = await (await fetch(base + '/api/devices/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"computer"}' })).json();
    assert.ok(cc.installUrl.startsWith('/i/'));
    const ip = await (await fetch(hubUrl + cc.installUrl)).text(); assert.match(ip, /Connect this computer/); assert.match(ip, /standby copy/);
    const f = await fetch(hubUrl + cc.installUrl + '/linux?standby=1', { headers: { 'X-Forwarded-Proto': 'http' } }); const script = await f.text();
    assert.ok(script.includes(`CODE="${cc.code}"`) && script.includes(`HUB="${hubUrl}"`) && script.includes('STANDBY="1"'), 'installer carries the code and this Cortex\'s address');
    ok('server: /install and /i/<code> pages; downloads carry the code and address; wrong or phone codes refused; viewing doesn\'t use the code');

    // ---------- run the Linux installer for real (GitHub download replaced by a local copy of this repo) ----------
    const home = path.join(T, 'home'); fs.mkdirSync(home);
    const fake = path.join(T, 'bin'); fs.mkdirSync(fake);
    const tarball = path.join(T, 'repo.tar.gz'); const folder = inst.source().folder;
    execFileSync('bash', ['-c', `cd "${path.join(__dirname, '..')}" && tar --exclude=.git --exclude=node_modules -czf "${tarball}" --transform 's,^\\.,${folder},' .`]);
    const realCurl = execFileSync('bash', ['-c', 'command -v curl']).toString().trim();
    fs.writeFileSync(path.join(fake, 'curl'), `#!/bin/bash\nfor a in "$@"; do case "$a" in https://codeload.github.com/*) cat "${tarball}"; exit 0;; esac; done\nexec "${realCurl}" "$@"\n`, { mode: 0o755 });
    const sf = path.join(T, 'install.sh'); fs.writeFileSync(sf, script);
    const r = spawnSync('bash', [sf], { input: '\n', env: { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, CORTEX_RUNNER_HOME: path.join(home, '.cortex-runner') }, timeout: 120000 });
    const out = r.stdout.toString() + r.stderr.toString();
    assert.equal(r.status, 0, out.slice(-1500));
    const conf = JSON.parse(fs.readFileSync(path.join(home, '.cortex-runner', 'config.json'), 'utf8'));
    assert.ok(conf.token && conf.hub === hubUrl && conf.device.kind === 'computer', 'paired and wrote the runner config');
    assert.ok(fs.existsSync(path.join(home, 'Cortex-app', 'bin', 'cortex.js')), 'Cortex downloaded and unpacked');
    assert.match(fs.readFileSync(path.join(home, '.config', 'autostart', 'cortex-runner.desktop'), 'utf8'), /runner --standby/, 'starts at login, in standby mode');
    let online = false;
    for (let i = 0; i < 40 && !online; i++) { await sleep(500); const d = await (await fetch(base + '/api/devices')).json(); online = (d.devices || []).some((x) => x.kind === 'computer' && x.online); }
    assert.ok(online, 'the new computer shows as online in the main Cortex');
    try { runnerPid = execFileSync('pgrep', ['-f', `${home}/Cortex-app/bin/cortex.js runner`]).toString().trim().split('\n').map(Number); } catch { runnerPid = null; }
    const again = spawnSync('bash', [sf], { input: '\n', env: { ...process.env, HOME: path.join(T, 'home2'), PATH: `${fake}:${process.env.PATH}` }, timeout: 60000 });
    assert.notEqual(again.status, 0); assert.match(again.stdout.toString(), /Pairing failed/, 'the code inside works only once');
    ok('Linux installer end to end: pairs first, downloads and unpacks Cortex, starts the runner in standby mode at login, shows online; the code can\'t be reused');
  } finally { if (runnerPid) for (const p of runnerPid) { try { process.kill(p); } catch { /* gone */ } } srv.kill(); await sleep(300); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} installer checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
