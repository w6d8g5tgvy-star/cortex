'use strict';
// Connection fixes (1.2.4): permanent Tailscale link detection, hook commands that run in PowerShell,
// self-repair of old hooks, and the agent prompt only naming tools that exist.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ok = (m) => console.log('  ✓ ' + m);

(async () => {
  console.log('Connections');
  const { funnelServes } = require(path.join(ROOT, 'src', 'tunnel.js'));
  const dns = 'pc.tail1234.ts.net';
  const good = { AllowFunnel: { [dns + ':443']: true }, Web: { [dns + ':443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } };
  assert.equal(funnelServes(good, dns, 7777), true);
  assert.equal(funnelServes({}, dns, 7777), false);
  assert.equal(funnelServes(good, dns, 8888), false);
  assert.equal(funnelServes({ ...good, AllowFunnel: {} }, dns, 7777), false);
  ok('Tailscale Funnel is recognised only when it serves this port publicly');

  // hooks: old command lines are repaired, the user's own hooks are kept (temp HOME)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-connect-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const cli = path.join(ROOT, 'bin', 'cortex.js');
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-connect-vault-'));
  const old = `"${process.execPath}" "${cli}" hook --vault "${vault}"`;
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: old, timeout: 10 }, { type: 'command', command: 'echo mine', timeout: 5 }] }] } }));
  const script = `
    const h = require(${JSON.stringify(path.join(ROOT, 'src', 'claude-hooks.js'))});
    const v = ${JSON.stringify(vault)};
    const r1 = h.repair({ vault: v }); const r2 = h.repair({ vault: v });
    const ins = require(${JSON.stringify(path.join(ROOT, 'src', 'instructions.js'))});
    const f = ins.fileFor('claude-code');
    require('fs').writeFileSync(f, 'My own notes\\n\\n<!-- cortex:start old -->\\nold prompt\\n<!-- cortex:end -->\\n');
    const before = ins.status()['claude-code']; ins.install('claude-code'); const after = ins.status()['claude-code'];
    console.log(JSON.stringify({ r1, r2, cmd: h.hookCommand(v), before, after, md: require('fs').readFileSync(f, 'utf8') }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, USERPROFILE: home, HOME: home } }).toString().trim().split('\n').pop());
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const all = Object.values(cfg.hooks).flat().flatMap((g) => g.hooks);
  const sameAsOld = out.cmd === old; // on Linux/Mac the quoted form is fine, so nothing needs repairing
  assert.equal(out.r1.repaired, true, 'missing events are added'); assert.equal(out.r2.repaired, false, 'second repair is a no-op');
  assert.ok(all.some((x) => x.command === 'echo mine'), "user's own hook kept");
  assert.ok(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'PermissionRequest', 'Stop', 'SessionEnd'].every((e) => cfg.hooks[e]));
  if (process.platform === 'win32') {
    assert.ok(!out.cmd.startsWith('"'), 'Windows hook command must not start with a quote (PowerShell rejects it)');
    assert.ok(!sameAsOld && !all.some((x) => x.command === old), 'old command replaced');
  }
  ok(`hooks repaired (${out.cmd.split(' ')[0]} …), all 7 events, user hook kept, idempotent`);
  assert.equal(out.before, 'outdated'); assert.equal(out.after, 'installed'); assert.ok(out.md.startsWith('My own notes'));
  ok("outdated instructions block is refreshed; the user's own text is kept");

  if (process.platform === 'win32') {
    const ev = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'connect-test', cwd: vault, reason: 'other' });
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', out.cmd], { input: ev, encoding: 'utf8', timeout: 30000 });
    assert.equal(ps.status, 0, `hook failed in PowerShell: ${ps.stderr}`);
    ok('hook command runs in Windows PowerShell');
  }

  const { PublicLink } = require('../src/tunnel');
  const link = new PublicLink(7777, () => 'tailscale');
  let stops = 0;
  link.quick.stop = () => { stops++; };
  link.funnel.start = async () => ({ running: false, url: null });
  await link.start();
  assert.equal(stops, 0);
  link.funnel.start = async () => ({ running: true, url: 'https://example.test' });
  await link.start();
  assert.equal(stops, 1);
  ok('quick tunnel survives pending approval and closes after successful handover');

  const { AGENT_PROMPT } = require(path.join(ROOT, 'src', 'snippets.js'));
  const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp.js'), 'utf8');
  const fields = ['user_instructions', 'project_instructions', 'commands_from_user', 'messages_from_user'];
  const named = [...new Set(AGENT_PROMPT.match(/\b[a-z]+_[a-z_]+\b/g))].filter((n) => !fields.includes(n) && !n.startsWith('mcp__'));
  assert.deepEqual(named.filter((n) => !mcpSrc.includes(`name: '${n}'`)), []);
  ok(`agent prompt names ${named.length} tools, all of which exist`);

  console.log('\nAll connection checks passed.');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
