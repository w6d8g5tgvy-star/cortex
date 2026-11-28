#!/usr/bin/env node
'use strict';
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`Cortex needs Node.js 18 or newer (you have ${process.version}). Download it from https://nodejs.org`);
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'start';
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=').slice(1).join('=') : def;
};
const has = (name) => args.includes(`--${name}`);
const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const HOSTED = process.env.CORTEX_STORE === 'cosmos'; // running on Azure App Service with Cosmos DB
const vault = path.resolve(expand(flag('vault', process.env.CORTEX_VAULT || (HOSTED ? require('../src/azure/hosted').defaultVault() : path.join(os.homedir(), 'Cortex')))));
const port = Number(flag('port', process.env.CORTEX_PORT || (HOSTED && process.env.PORT) || 7777));
const token = flag('token', process.env.CORTEX_TOKEN || '');

function openBrowser(url) {
  const plat = process.platform;
  const [bin, a] = plat === 'darwin' ? ['open', [url]] : plat === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(bin, a, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

const HELP = `Cortex — AI project manager & memory vault with an MCP server

Usage:
  cortex [start]          Start the dashboard + HTTP MCP endpoint (default). Auto-restarts after updates.
  cortex mcp              Run as an MCP server over stdio (Claude Desktop, Claude Code, Codex...)
  cortex config           Print copy-paste MCP configs for popular AI tools
  cortex hooks install    Stream Claude Code activity to Cortex's Live view (and phone)
  cortex hooks uninstall  Remove the Claude Code hooks
  cortex instructions     Add the Cortex prompt to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md (uninstall to remove)
  cortex setup            Connect Cortex to all your AI apps, enable phone access, start at login
  cortex update           Check for an update and install it
  cortex runner           Let this computer run agent jobs for your main Cortex
                          (first time: --hub <main Cortex address> --code <code> --folder <dir>)
                          --standby: also keep a copy of the main Cortex and serve it while the main computer is off
                          --sync [folder]: keep a full two-way synced copy of a main Cortex in the cloud (default ~/Cortex)
  cortex pair             Make a one-time pairing code (--computer for a computer, --url <address> for a link)
  cortex help             Show this help

Options:
  --vault <dir>   Vault folder (default ~/Cortex, env CORTEX_VAULT)
  --port <n>      Dashboard port (default 7777, env CORTEX_PORT)
  --host <addr>   Bind address (default 127.0.0.1, or 0.0.0.0 when phone access is on)
  --token <str>   Fixed access token for remote devices (default: auto-generated)
  --open          Open the dashboard in your browser after starting`;

// ---------------- supervisor: restarts on exit code 75, rolls back failed updates ----------------
function supervise() {
  const updater = require('../src/updater');
  let first = true;
  let child = null;
  const run = () => {
    const childArgs = [__filename, 'serve', ...args.filter((a) => a !== 'start' && (first || (a !== '--open' && a !== '--open-settings')))];
    first = false;
    const started = Date.now();
    child = spawn(process.execPath, childArgs, { stdio: 'inherit', env: { ...process.env, CORTEX_SUPERVISED: '1' } });
    child.on('exit', async (code, signal) => {
      child = null;
      if (code === 75) { console.log('\n  ↻ Restarting Cortex…\n'); return run(); }
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 130) return process.exit(0);
      const pending = updater.readPending();
      if (code !== 0 && pending && !pending.confirmed) {
        console.error(`\n  ✗ Cortex ${pending.to} failed to start. Rolling back to ${pending.from}…\n`);
        try { if (await updater.rollback()) return run(); } catch (e) { console.error('Rollback failed:', e.message); }
      }
      if (code !== 0 && Date.now() - started > 60000) { console.error('\n  Cortex crashed; restarting in 3s…'); return setTimeout(run, 3000); }
      process.exit(code || 0);
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (child) child.kill(sig); else process.exit(0); });
  run();
}

async function serve() {
  const { Store } = require('../src/store');
  const settings = require('../src/settings');
  let hosted = null;
  if (HOSTED) { // Azure: restore everything from Cosmos DB before anything else reads the vault
    const az = require('../src/azure/hosted');
    try { hosted = await az.prepare(vault); } catch (e) { console.error(`Couldn't restore from Cosmos DB: ${e.message}`); process.exit(1); }
  }
  const s = settings.load(vault);
  const host = flag('host', process.env.CORTEX_HOST || (s.remote.enabled ? '0.0.0.0' : '127.0.0.1'));
  const store = new Store(vault);
  const { startServer, lanAddresses } = require('../src/server');
  try {
    await startServer({ store, port, host, token });
    if (hosted) {
      const keeper = require('../src/azure/hosted').startPersistence({ cosmos: hosted.cosmos, vault, known: hosted.known, store });
      global.cortexPersistence = keeper;
      for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await keeper.flush(); } catch (e) { console.error('Final save to Cosmos DB failed:', e.message); } process.exit(0); });
      console.log('  Cortex is running on Azure: changes are saved to Cosmos DB.');
    }
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Cortex may already be running: http://127.0.0.1:${port}\nUse --port to pick another port.`);
      if (has('open')) openBrowser(`http://127.0.0.1:${port}`);
      process.exit(2);
    }
    throw e;
  }
  const url = `http://127.0.0.1:${port}`;
  const openUrl = has('open-settings') ? url + '/#/settings' : url;
  const remote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  console.log(`
  ◆ Cortex ${require('../package.json').version} is running

    Dashboard  ${url}
    MCP (HTTP) ${url}/mcp
    Vault      ${vault}
${remote ? `    Phone      ${lanAddresses(port).map((a) => a.url).join('  ') || '(no network found)'}  (pair from Settings → Phone access)\n` : ''}
  Press Ctrl+C to stop. Run "cortex config" for agent setup snippets.
`);
  if (has('open') || has('open-settings')) openBrowser(openUrl);
}

async function main() {
  if (cmd === 'help' || has('help') || has('h')) return console.log(HELP);

  if (cmd === 'runner') {
    const folders = args.map((x, i) => (x === '--folder' ? args[i + 1] : null)).filter(Boolean);
    try { await require('../src/runner-client').start({ hub: flag('hub'), code: flag('code'), name: flag('name'), folders, once: has('once'), standby: has('standby'), sync: has('sync') ? (flag('sync') && !String(flag('sync')).startsWith('--') ? flag('sync') : true) : false, port: Number(flag('port')) || 7777, takeoverMinutes: flag('takeover-minutes') !== undefined ? Number(flag('takeover-minutes')) : 5 }); }
    catch (e) { console.error('✗ ' + e.message); process.exit(1); }
    return;
  }

  if (cmd === 'mcp') {
    const { Store } = require('../src/store');
    require('../src/mcp').runStdio(new Store(vault));
    return;
  }

  if (cmd === 'hook') {
    // Called by Claude Code hooks. Must be fast, quiet and never fail.
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (input += d));
    process.stdin.on('end', async () => {
      try {
        const out = await require('../src/claude-hooks').runHook(JSON.parse(input || '{}'), vault);
        if (out) process.stdout.write(JSON.stringify(out));
      } catch { /* never break Claude */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 145000).unref(); // Claude Code's per-event timeouts cut this shorter
    return;
  }

  if (cmd === 'hooks') {
    const ch = require('../src/claude-hooks');
    const sub = args[1];
    if (sub === 'install') {
      const r = ch.install({ vault });
      console.log(`✓ Claude Code hooks installed in ${r.settingsFile}\n  (backup: ${r.backup})\n  ✓ Skill installed: ~/.claude/skills/cortex\n\nRestart Claude Code. Its activity will now appear in Cortex → Live, and messages you send\nfrom your phone will be delivered to Claude while it works.\n\nAlso connect the MCP server if you haven't:\n  claude mcp add --scope user cortex -- "${process.execPath}" "${__filename}" mcp`);
    } else if (sub === 'uninstall') {
      ch.uninstall();
      console.log('✓ Cortex hooks removed from Claude Code settings.');
    } else console.log(ch.status());
    return;
  }

  if (cmd === 'pair') { // make a pairing code from the command line (for servers with no screen)
    const kind = has('computer') ? 'computer' : 'phone';
    const c = require('../src/devices').createCode(vault, { kind, name: flag('name') });
    const base = (flag('url') || '').replace(/\/+$/, '');
    console.log(`\n  Pairing code for a ${kind}: ${c.code}  (works once, for ${c.minutes} minutes)`);
    if (base) console.log(kind === 'phone' ? `  On your phone open: ${base}/pair?code=${encodeURIComponent(c.code)}` : `  On the other computer open: ${base}/i/${encodeURIComponent(c.code)}`);
    else console.log(`  On your ${kind}, open this Cortex's address and enter the code${kind === 'phone' ? ' at /pair' : ' at /i/<code>'}.`);
    console.log('');
    process.exit(0);
  }
  if (cmd === 'setup') {
    const results = require('../src/appsetup').run(vault, { phone: !has('no-phone'), screen: !has('no-screen'), autostart: !has('no-autostart') });
    const icon = { ok: '✓', skip: '–', fail: '✗' };
    console.log('\n  ◆ Cortex setup\n');
    for (const r of results) console.log(`  ${icon[r.status]} ${r.name.padEnd(16)} ${r.msg}`);
    console.log(`\n  Vault: ${vault}\n  Every file changed was backed up as <file>.cortex-backup.\n  Restart your AI apps so they pick up Cortex.\n  Next: open Settings → Phone access in the dashboard and scan the QR code with your phone.\n`);
    return;
  }

  if (cmd === 'instructions') {
    const ins = require('../src/instructions');
    const sub = args[1] || 'install';
    for (const t of Object.keys(ins.TARGETS)) {
      const r = sub === 'uninstall' ? ins.uninstall(t) : ins.install(t);
      console.log(`${ins.TARGETS[t].label}: ${r.skipped ? r.reason : sub === 'uninstall' ? (r.removed ? 'removed the Cortex block' : 'nothing to remove') : `Cortex prompt is in ${r.file}`}`);
    }
    return;
  }

  if (cmd === 'update') {
    const updater = require('../src/updater');
    const s = require('../src/settings').load(vault);
    const source = flag('source', s.updates.source);
    const info = await updater.check(source);
    if (info.error) { console.log(info.error + '. Set one in Settings → Updates or pass --source owner/repo'); return; }
    if (!info.available) { console.log(`Cortex ${info.current} is up to date.`); return; }
    console.log(`Updating Cortex ${info.current} → ${info.latest}…`);
    const r = await updater.apply(info);
    updater.confirm();
    console.log(`✓ Installed ${r.to}. Restart Cortex to use it (running dashboards restart automatically when they update themselves).`);
    return;
  }

  if (cmd === 'config') {
    const { snippets } = require('../src/snippets');
    const s = snippets({ vault, port, host: '127.0.0.1', token });
    console.log(`\nCortex MCP connection configs  (vault: ${vault})\n`);
    console.log(`━━ Prompt for your AI agents ━━  paste into CLAUDE.md, ChatGPT custom instructions, or project instructions\n${s.agentPrompt}\n`);
    for (const it of s.items) {
      console.log(`━━ ${it.name} ━━  ${it.where}\n${it.code}\n`);
      if (it.alt) console.log(`${it.altLabel}\n${it.alt}\n`);
    }
    return;
  }

  if (cmd === 'serve') return serve();
  if (cmd === 'start') return has('no-supervisor') ? serve() : supervise();
  console.error(`Unknown command "${cmd}". Run: cortex help`);
  process.exit(1);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
