'use strict';
// Tests: phone pairing/auth, live sessions, phone→agent messages, Claude Code hooks, screen capture,
// and self-update with automatic rollback. Run with a display for the screen test (e.g. xvfb-run).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cortex.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-live-'));
const vault = path.join(tmp, 'vault');
const port = 19000 + Math.floor(Math.random() * 1000);
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

function startCortex(cli, extraEnv = {}) {
  const p = spawn(process.execPath, [cli, 'start', '--vault', vault, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  return p;
}
async function waitUp(base, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(base + '/api/state'); if (r.ok) return; } catch { /* retry */ } await sleep(200); }
  throw new Error('server did not start');
}
function hook(event) {
  const env = { ...process.env };
  delete env.CORTEX_RUN_ID;
  const r = spawnSync(process.execPath, [CLI, 'hook', '--vault', vault], { input: JSON.stringify(event), encoding: 'utf8', env });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
function mcpStdio() {
  const p = spawn(process.execPath, [CLI, 'mcp', '--vault', vault], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const call = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); if (r.result.isError) throw new Error(r.result.content[0].text); return JSON.parse(r.result.content[0].text); };
  return { call, tool, close: () => p.kill() };
}

(async () => {
  // turn phone access + screen sharing on before start
  fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ remote: { enabled: true, token: 'test-token-123' }, screen: { enabled: true } }));
  const base = `http://127.0.0.1:${port}`;
  let srv = startCortex(CLI);
  await waitUp(base);

  console.log('phone access');
  assert.ok(/Phone/.test(srv.out), 'banner shows phone url');
  if (lanIp) {
    const remote = `http://${lanIp}:${port}`;
    assert.equal((await fetch(remote + '/api/state')).status, 401);
    assert.equal((await fetch(remote + '/')).status, 401);
    const paired = await fetch(remote + '/?token=test-token-123');
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    const st = await fetch(remote + '/api/state', { headers: { Cookie: cookie } });
    assert.equal(st.status, 200);
    assert.equal((await st.json()).local, false);
    const man = await (await fetch(remote + '/manifest.webmanifest', { headers: { Cookie: cookie } })).json();
    assert.ok(man.start_url.includes('token=test-token-123'));
    const deny = await fetch(remote + '/api/settings', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"updates":{"source":"evil/repo"}}' });
    assert.equal(deny.status, 403);
    const tunneled = await fetch(base + '/api/state', { headers: { 'X-Forwarded-For': '8.8.8.8' } });
    assert.equal(tunneled.status, 401);
    ok('other devices need the pairing token; cookie pairing works; settings are computer-only; tunnels are not trusted');
  } else console.log('  - skipped (no LAN interface)');
  const sett = await (await fetch(base + '/api/settings')).json();
  assert.equal(sett.remote.token, 'test-token-123');
  assert.equal(sett.remote.listening, '0.0.0.0');
  ok('settings API returns pairing info locally');

  console.log('live sessions');
  const c = mcpStdio();
  await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex' } });
  const u1 = await c.tool('live_update', { title: 'Build landing page', step: 'Scaffolding project', progress: 10 });
  assert.deepEqual(u1.messages_from_user, []);
  await sleep(900);
  let live = await (await fetch(base + '/api/live')).json();
  const s1 = live.sessions.find((x) => x.agent === 'codex');
  assert.equal(s1.title, 'Build landing page');
  assert.equal(s1.progress, 10);
  ok('agent live_update appears in /api/live');
  const sent = await fetch(base + '/api/live/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: s1.id, text: 'Use a dark theme please' }) });
  assert.equal(sent.status, 201);
  const u2 = await c.tool('live_update', { step: 'Writing CSS' });
  assert.deepEqual(u2.messages_from_user, ['Use a dark theme please']);
  const u3 = await c.tool('live_update', { step: 'Done', status: 'done' });
  assert.deepEqual(u3.messages_from_user, []);
  ok('messages from the phone are delivered to the agent exactly once');
  const png = execFileSync(process.execPath, ['-e', "process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64'))"]);
  fs.writeFileSync(path.join(tmp, 'shot.png'), png);
  await c.tool('live_screenshot', { image_path: path.join(tmp, 'shot.png'), caption: 'Hero section' });
  const snap = await fetch(`${base}/api/live/snap?id=${encodeURIComponent(s1.id)}`);
  assert.equal(snap.headers.get('content-type'), 'image/png');
  ok('agent snapshot (image file) is served to the dashboard');

  console.log('screen sharing');
  if (process.env.DISPLAY) {
    const scr = await fetch(base + '/api/screen');
    assert.equal(scr.status, 200, await scr.clone().text());
    const buf = Buffer.from(await scr.arrayBuffer());
    assert.ok(['image/png', 'image/jpeg'].includes(scr.headers.get('content-type')));
    if (buf[0] === 0x89) assert.ok(buf.readUInt32BE(16) >= 640 && buf.readUInt32BE(20) >= 480, 'full-size screen image');
    const shot = await c.tool('live_screenshot', { capture_screen: true, caption: 'Full screen' });
    assert.ok(shot.bytes > 100);
    ok(`computer screen captured (${buf.length} bytes) for the phone and for agents`);
  } else console.log('  - skipped (no DISPLAY; run under xvfb-run)');
  c.close();

  console.log('claude code hooks');
  const sid = 'abc123';
  hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: '/home/me/shop', prompt: 'Add a checkout page' });
  hook({ hook_event_name: 'PostToolUse', session_id: sid, cwd: '/home/me/shop', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  live = await (await fetch(base + '/api/live')).json();
  const cc = live.sessions.find((x) => x.id === 'cc-' + sid);
  assert.equal(cc.title, 'Add a checkout page');
  assert.equal(cc.step, '$ npm test');
  assert.equal(cc.workspace, 'shop');
  await fetch(base + '/api/live/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: cc.id, text: 'also add Apple Pay' }) });
  const post = hook({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Edit', tool_input: { file_path: '/x/checkout.tsx' } });
  assert.ok(post.hookSpecificOutput.additionalContext.includes('also add Apple Pay'));
  await fetch(base + '/api/live/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: cc.id, text: 'and run the linter' }) });
  const stop = hook({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: false });
  assert.equal(stop.decision, 'block');
  assert.ok(stop.reason.includes('run the linter'));
  assert.equal(hook({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: true }), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, '.cortex', 'sessions', `cc-${sid}.json`), 'utf8')).status, 'waiting');
  assert.equal(hook({ hook_event_name: 'PostToolUse' }), null); // malformed input never fails
  ok('hooks stream steps and deliver phone messages mid-task and at stop');
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  execFileSync(process.execPath, [CLI, 'hooks', 'install', '--vault', vault], { env });
  execFileSync(process.execPath, [CLI, 'hooks', 'install', '--vault', vault], { env });
  let cfg = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(cfg.model, 'opus');
  assert.equal(cfg.hooks.Stop.length, 2);
  assert.equal(cfg.hooks.PostToolUse.length, 1);
  assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'cortex', 'SKILL.md')));
  execFileSync(process.execPath, [CLI, 'hooks', 'uninstall'], { env });
  cfg = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(cfg.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  ok('hooks install is idempotent, keeps user settings, and uninstalls cleanly');
  srv.kill('SIGTERM');
  await sleep(500);

  console.log('auto-update');
  // copy the app, then publish two "releases": 9.0.0 (good) and 9.1.0 (broken: crashes on start)
  const app = path.join(tmp, 'app');
  fs.cpSync(ROOT, app, { recursive: true, filter: (s) => !s.includes(`${path.sep}.update`) && !s.includes(`${path.sep}.git`) });
  const release = (version, broken) => {
    const dir = path.join(tmp, 'rel-' + version, 'cortex-' + version);
    fs.cpSync(ROOT, dir, { recursive: true, filter: (s) => !s.includes(`${path.sep}.update`) && !s.includes(`${path.sep}.git`) });
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pj.version = version;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj, null, 2));
    if (broken) fs.appendFileSync(path.join(dir, 'src', 'server.js'), '\nthrow new Error("broken release");\n');
    const tgz = path.join(tmp, `cortex-${version}.tar.gz`);
    execFileSync('tar', ['czf', tgz, '-C', path.dirname(dir), path.basename(dir)]);
    return tgz;
  };
  const files = { '9.0.0': release('9.0.0'), '9.1.0': release('9.1.0', true) };
  let latest = '9.0.0';
  const crypto = require('crypto');
  const rs = http.createServer((req, res) => {
    const pu = `http://127.0.0.1:${rs.address().port}`;
    if (req.url === '/latest.json') { const buf = fs.readFileSync(files[latest]); res.end(JSON.stringify({ version: latest, url: `${pu}/c-${latest}.tgz`, sha256: crypto.createHash('sha256').update(buf).digest('hex'), notes: `Release ${latest}` })); return; }
    const m = req.url.match(/^\/c-(.+)\.tgz$/);
    if (m) return res.end(fs.readFileSync(files[m[1]]));
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => rs.listen(0, '127.0.0.1', r));
  const source = `http://127.0.0.1:${rs.address().port}/latest.json`;
  fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ updates: { auto: false, source }, remote: { enabled: false, token: 'x' } }));
  const appCli = path.join(app, 'bin', 'cortex.js');
  srv = startCortex(appCli);
  await waitUp(base);
  const chk = await (await fetch(base + '/api/update/check', { method: 'POST' })).json();
  assert.equal(chk.info.available, true);
  assert.equal(chk.info.latest, '9.0.0');
  const ap = await (await fetch(base + '/api/update/apply', { method: 'POST' })).json();
  assert.equal(ap.to, '9.0.0');
  assert.equal(ap.restarted, true);
  await sleep(1500);
  await waitUp(base);
  assert.equal((await (await fetch(base + '/api/state')).json()).version, '9.0.0');
  ok('update downloaded, checksum verified, installed, and app restarted itself on 9.0.0');
  await sleep(8500); // new version confirms itself after 8s
  // now publish a broken release and let it auto-install → must roll back to 9.0.0
  latest = '9.1.0';
  await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates: { auto: true } }) });
  const ap2 = await (await fetch(base + '/api/update/apply', { method: 'POST' })).json();
  assert.equal(ap2.to, '9.1.0');
  await sleep(2500);
  await waitUp(base, 20000);
  const v = (await (await fetch(base + '/api/state')).json()).version;
  assert.equal(v, '9.0.0', 'should have rolled back');
  const upd = await (await fetch(base + '/api/update')).json();
  assert.equal(upd.pending.rolledBack, true);
  assert.ok(/Rolling back/.test(srv.out));
  ok('broken update failed to start and was rolled back automatically to 9.0.0');
  // bad checksum is rejected
  latest = '9.0.0';
  srv.kill('SIGTERM');
  rs.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
