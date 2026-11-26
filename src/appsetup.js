'use strict';
// One-step setup: connects Cortex to every AI app it finds on this computer, turns on phone access
// and screen sharing, configures updates, and starts Cortex automatically at login.
// Every file it changes is backed up first (<file>.cortex-backup).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const settings = require('./settings');
const claudeHooks = require('./claude-hooks');
const pkg = require('../package.json');

const CLI = path.resolve(__dirname, '..', 'bin', 'cortex.js');
const NODE = process.execPath;
const HOME = os.homedir();
const plat = process.platform;
const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

function backupWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(file + '.cortex-backup')) fs.copyFileSync(file, file + '.cortex-backup');
  fs.writeFileSync(file, text);
}
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const t = fs.readFileSync(file, 'utf8').trim();
  return t ? JSON.parse(t) : {};
}
function onPath(bin) {
  const exts = plat === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) for (const e of exts) { if (fs.existsSync(path.join(dir, bin + e))) return path.join(dir, bin + e); }
  return null;
}
const stdio = (vault) => ({ command: NODE, args: [CLI, 'mcp'], env: { CORTEX_VAULT: vault } });
// On Windows `claude` is a .cmd shim, which needs a shell: quote every argument so paths with spaces survive.
function runClaude(claude, args) {
  if (plat === 'win32') return execFileSync(`"${claude}" ${args.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ')}`, { stdio: 'ignore', timeout: 30000, shell: true, windowsHide: true });
  return execFileSync(claude, args, { stdio: 'ignore', timeout: 30000 });
}

const steps = {
  settings(vault, o) {
    const s = settings.update(vault, {
      remote: { enabled: o.phone },
      screen: { enabled: o.screen },
      updates: { auto: true, source: settings.load(vault).updates.source || (pkg.cortex && pkg.cortex.updateSource) || '' },
    });
    return `phone access ${s.remote.enabled ? 'on' : 'off'}, screen sharing ${s.screen.enabled ? 'on' : 'off'}, auto-updates on${s.updates.source ? ` from ${s.updates.source}` : ''}`;
  },
  claudeCode(vault) {
    const claude = onPath('claude');
    const hooks = claudeHooks.install({ vault });
    if (!claude) return { skip: false, msg: `live-view hooks + skill installed (${hooks.settingsFile}). Claude Code CLI not found on PATH, so add the MCP server later with: cortex config` };
    try { runClaude(claude, ['mcp', 'remove', '--scope', 'user', 'cortex']); } catch { /* not there yet */ }
    runClaude(claude, ['mcp', 'add', '--scope', 'user', '-e', `CORTEX_VAULT=${vault}`, 'cortex', '--', NODE, CLI, 'mcp']);
    return 'MCP server added, live-view hooks + skill installed';
  },
  claudeDesktop(vault) {
    const dir = plat === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Claude') : plat === 'win32' ? path.join(appData, 'Claude') : path.join(HOME, '.config', 'Claude');
    if (!fs.existsSync(dir)) return { skip: true, msg: 'not installed' };
    const file = path.join(dir, 'claude_desktop_config.json');
    const cfg = readJson(file);
    cfg.mcpServers = { ...(cfg.mcpServers || {}), cortex: stdio(vault) };
    backupWrite(file, JSON.stringify(cfg, null, 2) + '\n');
    return 'added to claude_desktop_config.json (restart Claude Desktop)';
  },
  cursor(vault) {
    const dir = path.join(HOME, '.cursor');
    if (!fs.existsSync(dir)) return { skip: true, msg: 'not installed' };
    const file = path.join(dir, 'mcp.json');
    const cfg = readJson(file);
    cfg.mcpServers = { ...(cfg.mcpServers || {}), cortex: stdio(vault) };
    backupWrite(file, JSON.stringify(cfg, null, 2) + '\n');
    return 'added to ~/.cursor/mcp.json';
  },
  windsurf(vault) {
    const dir = path.join(HOME, '.codeium', 'windsurf');
    if (!fs.existsSync(dir)) return { skip: true, msg: 'not installed' };
    const file = path.join(dir, 'mcp_config.json');
    const cfg = readJson(file);
    cfg.mcpServers = { ...(cfg.mcpServers || {}), cortex: stdio(vault) };
    backupWrite(file, JSON.stringify(cfg, null, 2) + '\n');
    return 'added to Windsurf mcp_config.json';
  },
  codex(vault) {
    const dir = path.join(HOME, '.codex');
    if (!fs.existsSync(dir)) return { skip: true, msg: 'not installed' };
    const file = path.join(dir, 'config.toml');
    let toml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    toml = toml.replace(/\n?\[mcp_servers\.cortex\][\s\S]*?(?=\n\[|$)/, '');
    toml = toml.replace(/\s*$/, '') + `\n\n[mcp_servers.cortex]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(CLI)}, "mcp"]\nenv = { CORTEX_VAULT = ${JSON.stringify(vault)} }\n`;
    backupWrite(file, toml.replace(/^\s+/, ''));
    return 'added to ~/.codex/config.toml';
  },
  autostart(vault) {
    if (plat === 'darwin') {
      const file = path.join(HOME, 'Library', 'LaunchAgents', 'com.cortex.dashboard.plist');
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      backupWrite(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.cortex.dashboard</string>
  <key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(CLI)}</string><string>start</string><string>--vault</string><string>${esc(vault)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(vault, '.cortex', 'cortex.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(vault, '.cortex', 'cortex.log'))}</string>
</dict></plist>
`);
      return 'starts at login (LaunchAgent)';
    }
    if (plat === 'win32') {
      const file = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Cortex.vbs');
      const q = (s) => `""${s}""`;
      backupWrite(file, `' Starts Cortex in the background at login\r\nCreateObject("WScript.Shell").Run "${q(NODE)} ${q(CLI)} start --vault ${q(vault)}", 0, False\r\n`);
      return 'starts at login (Startup folder)';
    }
    const file = path.join(HOME, '.config', 'autostart', 'cortex.desktop');
    backupWrite(file, `[Desktop Entry]\nType=Application\nName=Cortex\nComment=AI project manager and memory\nExec="${NODE}" "${CLI}" start --vault "${vault}"\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
    return 'starts at login (~/.config/autostart)';
  },
};

function run(vault, o = {}) {
  const opts = { phone: o.phone !== false, screen: o.screen !== false, autostart: o.autostart !== false };
  const plan = [
    ['Cortex settings', () => steps.settings(vault, opts)],
    ['Claude Code', () => steps.claudeCode(vault)],
    ['Claude Desktop', () => steps.claudeDesktop(vault)],
    ['Cursor', () => steps.cursor(vault)],
    ['Windsurf', () => steps.windsurf(vault)],
    ['Codex CLI', () => steps.codex(vault)],
    ['Agent prompt', () => { const ins = require('./instructions'); const r = ['claude-code', 'codex'].map((t) => ins.install(t)).filter((x) => !x.skipped); return r.length ? `added to ${r.map((x) => x.file).join(' and ')} (your own text there is untouched)` : { skip: true, msg: 'Claude Code / Codex not installed' }; }],
    ...(opts.autostart ? [['Start at login', () => steps.autostart(vault)]] : []),
  ];
  const results = [];
  for (const [name, fn] of plan) {
    try {
      const r = fn();
      results.push(typeof r === 'string' ? { name, status: 'ok', msg: r } : { name, status: r.skip ? 'skip' : 'ok', msg: r.msg });
    } catch (e) { results.push({ name, status: 'fail', msg: e.message }); }
  }
  return results;
}

module.exports = { run };
