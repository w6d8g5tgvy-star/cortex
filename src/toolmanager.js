'use strict';
// Universal AI tool manager (2.3, checklist #15). One place to see and manage the tools your AI apps use:
//   - MCP servers set up in Claude Desktop, Claude Code, Cursor, Windsurf and Codex (read from their own config files)
//   - "connect once, share": copy a server you set up in one app into your other apps
//   - health checks: start the server and ask it for its tools (MCP initialize + tools/list)
//   - local tools (CLIs) and which AI API keys are set in the environment (never their values)
// Credentials stay where they are: in each app's own config. Cortex never stores them, never puts them in memory
// notes, and never shows their values (only the names). Cortex only removes servers it added itself; your own
// entries are never changed or removed, and every config file is backed up before the first change.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const home = () => process.env.CORTEX_TOOLS_HOME || os.homedir();
const appData = () => process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
const plat = process.platform;
const SECRETY = /key|token|secret|password|passwd|auth|credential|cookie|session|bearer|pat$/i;

function apps() {
  const H = home();
  const desktopDir = plat === 'darwin' ? path.join(H, 'Library', 'Application Support', 'Claude') : plat === 'win32' ? path.join(appData(), 'Claude') : path.join(H, '.config', 'Claude');
  return {
    claudeDesktop: { label: 'Claude Desktop', dir: desktopDir, file: path.join(desktopDir, 'claude_desktop_config.json'), format: 'json', restart: 'Restart Claude Desktop' },
    claudeCode: { label: 'Claude Code', dir: path.join(H, '.claude'), file: path.join(H, '.claude.json'), format: 'json', restart: 'Start a new Claude Code session' },
    cursor: { label: 'Cursor', dir: path.join(H, '.cursor'), file: path.join(H, '.cursor', 'mcp.json'), format: 'json', restart: 'Reload Cursor' },
    windsurf: { label: 'Windsurf', dir: path.join(H, '.codeium', 'windsurf'), file: path.join(H, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json', urlKey: 'serverUrl', restart: 'Reload Windsurf' },
    codex: { label: 'Codex', dir: path.join(H, '.codex'), file: path.join(H, '.codex', 'config.toml'), format: 'toml', restart: 'Start a new Codex session' },
  };
}

// ---- reading/writing configs ----
function readJson(file) { try { const t = fs.readFileSync(file, 'utf8').trim(); return t ? JSON.parse(t) : {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Couldn't read ${file}: ${e.message}`); } }
function backupWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(file + '.cortex-backup')) fs.copyFileSync(file, file + '.cortex-backup');
  const tmp = file + '.cortex-tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
}
// Minimal TOML for [mcp_servers.<name>] tables: command, args, env, url, enabled. Other content is left untouched.
function tomlValue(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v.startsWith('[')) { const out = []; const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g; let m; while ((m = re.exec(v))) out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]); return out; }
  if (v.startsWith('{')) { const out = {}; const re = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g; let m; while ((m = re.exec(v))) out[m[1]] = tomlValue(m[2]); return out; }
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
function readToml(file) {
  let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const servers = {}; let cur = null; let sub = null;
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim(); if (!line) continue;
    const h = line.match(/^\[mcp_servers\.("?)([^\]".]+)\1(?:\.(env))?\]$/);
    if (h) { cur = servers[h[2]] = servers[h[2]] || {}; sub = h[3] || null; continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/); if (!kv) continue;
    if (sub === 'env') { (cur.env = cur.env || {})[kv[1]] = tomlValue(kv[2]); } else cur[kv[1]] = tomlValue(kv[2]);
  }
  return servers;
}
function tomlSection(name, def) {
  const q = (s) => JSON.stringify(String(s));
  let out = `[mcp_servers.${name}]\ncommand = ${q(def.command)}\n`;
  if (def.args && def.args.length) out += `args = [${def.args.map(q).join(', ')}]\n`;
  if (def.env && Object.keys(def.env).length) out += `env = { ${Object.entries(def.env).map(([k, v]) => `${k} = ${q(v)}`).join(', ')} }\n`;
  return out;
}

function serversOf(appKey) {
  const a = apps()[appKey];
  if (a.format === 'toml') return readToml(a.file);
  const j = readJson(a.file); return (j && typeof j.mcpServers === 'object' && j.mcpServers) || {};
}
const kindOf = (def) => (def.url || def.serverUrl ? 'http' : 'stdio');
const sameDef = (a, b) => kindOf(a) === kindOf(b) && (kindOf(a) === 'http' ? (a.url || a.serverUrl) === (b.url || b.serverUrl) : a.command === b.command && JSON.stringify(a.args || []) === JSON.stringify(b.args || []));
/** What may be shown: env/header NAMES only, never values. */
function publicDef(def) {
  return { kind: kindOf(def), command: def.command ? path.basename(String(def.command)) : undefined, commandPath: def.command, args: (def.args || []).map((x) => (SECRETY.test(String(x)) || /^[A-Za-z0-9_-]{32,}$/.test(String(x)) ? '••••' : x)), url: def.url || def.serverUrl ? String(def.url || def.serverUrl).replace(/([?&][^=]*(?:key|token|secret)[^=]*=)[^&]+/gi, '$1••••') : undefined, env: Object.keys(def.env || {}), headers: Object.keys(def.headers || {}), disabled: def.disabled === true || def.enabled === false };
}

// ---- managed list (what Cortex added, so it can remove only those) ----
const managedFile = (vault) => path.join(vault, '.cortex', 'tools.json');
const loadManaged = (vault) => { try { return JSON.parse(fs.readFileSync(managedFile(vault), 'utf8')); } catch { return { added: [] }; } };
const saveManaged = (vault, m) => { fs.mkdirSync(path.dirname(managedFile(vault)), { recursive: true }); fs.writeFileSync(managedFile(vault), JSON.stringify(m, null, 1)); };

/** Every app, whether it's installed, and its MCP servers (values hidden). Plus servers grouped across apps. */
function inventory(vault) {
  const A = apps(); const managed = loadManaged(vault).added; const out = { apps: {}, servers: {} };
  for (const [k, a] of Object.entries(A)) {
    const installed = fs.existsSync(a.dir) || fs.existsSync(a.file);
    let servers = {}; let error = null; try { servers = installed ? serversOf(k) : {}; } catch (e) { error = e.message; }
    out.apps[k] = { label: a.label, installed, file: a.file, error, count: Object.keys(servers).length, restart: a.restart };
    for (const [name, def] of Object.entries(servers)) {
      const s = out.servers[name] = out.servers[name] || { name, in: {}, variants: 0 };
      s.in[k] = { ...publicDef(def), managed: managed.some((m) => m.name === name && m.app === k) };
    }
  }
  for (const s of Object.values(out.servers)) {
    const defs = Object.entries(s.in).map(([k]) => serversOf(k)[s.name]);
    s.variants = defs.filter((d, i) => defs.findIndex((x) => sameDef(x, d)) === i).length; // >1: same name, different setups
    s.canShareTo = Object.entries(out.apps).filter(([k, a]) => a.installed && !s.in[k] && !(k === 'codex' && Object.values(s.in).every((x) => x.kind === 'http'))).map(([k]) => k);
  }
  return out;
}

/** Copy server `name` from app `from` into each app in `to`. Never overwrites an existing entry. */
function share(vault, name, from, to, { claudeBin } = {}) {
  const A = apps(); if (!A[from]) throw new Error('Unknown source app');
  const def = serversOf(from)[name]; if (!def) throw new Error(`"${name}" isn't set up in ${A[from].label}`);
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) throw new Error('That server name can\'t be copied safely');
  const results = []; const m = loadManaged(vault);
  for (const k of to || []) {
    const a = A[k]; if (!a) { results.push({ app: k, ok: false, msg: 'Unknown app' }); continue; }
    if (!(fs.existsSync(a.dir) || fs.existsSync(a.file))) { results.push({ app: k, ok: false, msg: `${a.label} isn't installed` }); continue; }
    try {
      const existing = serversOf(k)[name];
      if (existing) { results.push({ app: k, ok: sameDef(existing, def), msg: sameDef(existing, def) ? 'already there' : `${a.label} already has a different "${name}": left as it is` }); continue; }
      const http = kindOf(def) === 'http';
      if (k === 'codex') {
        if (http) throw new Error('Codex only takes command-line (stdio) MCP servers here');
        let toml = ''; try { toml = fs.readFileSync(a.file, 'utf8'); } catch { /* new */ }
        backupWrite(a.file, `${toml.replace(/\s*$/, '')}${toml.trim() ? '\n\n' : ''}${tomlSection(name, def)}`);
      } else if (k === 'claudeCode' && claudeBin && !process.env.CORTEX_TOOLS_HOME) { // Claude Code owns ~/.claude.json: go through its CLI when we can
        const json = JSON.stringify(http ? { type: 'http', url: def.url || def.serverUrl, ...(def.headers ? { headers: def.headers } : {}) } : { type: 'stdio', command: def.command, args: def.args || [], env: def.env || {} });
        execFileSync(claudeBin, ['mcp', 'add-json', '--scope', 'user', name, json], { stdio: 'ignore', timeout: 30000, shell: plat === 'win32' });
      } else {
        const cfg = readJson(a.file); cfg.mcpServers = cfg.mcpServers || {};
        const copy = http ? { [a.urlKey || 'url']: def.url || def.serverUrl, ...(def.headers ? { headers: def.headers } : {}) } : { command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) };
        cfg.mcpServers[name] = copy;
        backupWrite(a.file, JSON.stringify(cfg, null, 2) + '\n');
      }
      m.added.push({ name, app: k, from, at: new Date().toISOString() });
      results.push({ app: k, ok: true, msg: `added (${a.restart})` });
    } catch (e) { results.push({ app: k, ok: false, msg: e.message }); }
  }
  saveManaged(vault, m);
  return results;
}

/** Remove a server from an app, only if Cortex added it there. */
function unshare(vault, name, app, { claudeBin } = {}) {
  const A = apps(); const m = loadManaged(vault);
  const i = m.added.findIndex((x) => x.name === name && x.app === app);
  if (i < 0) throw new Error(`Cortex didn't add "${name}" to ${A[app] ? A[app].label : app}, so it won't remove it (remove it in that app if you want).`);
  const a = A[app];
  if (app === 'codex') {
    const toml = fs.readFileSync(a.file, 'utf8');
    const re = new RegExp(`\\n?\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.env)?\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.env\\])|$)`, 'g');
    backupWrite(a.file, toml.replace(re, '').replace(/\n{3,}/g, '\n\n'));
  } else if (app === 'claudeCode' && claudeBin && !process.env.CORTEX_TOOLS_HOME) {
    execFileSync(claudeBin, ['mcp', 'remove', '--scope', 'user', name], { stdio: 'ignore', timeout: 30000, shell: plat === 'win32' });
  } else {
    const cfg = readJson(a.file); if (cfg.mcpServers) delete cfg.mcpServers[name]; backupWrite(a.file, JSON.stringify(cfg, null, 2) + '\n');
  }
  m.added.splice(i, 1); saveManaged(vault, m);
  return { ok: true };
}

/** Start the server (or call its URL) and ask for its tools. Never prints secrets: only counts, names and timing. */
function check(name, app, { timeoutMs = 10000 } = {}) {
  const def = serversOf(app)[name]; if (!def) return Promise.resolve({ ok: false, error: 'Not found' });
  const t0 = Date.now();
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cortex-health', version: '1' } } };
  if (kindOf(def) === 'http') {
    const url = def.url || def.serverUrl;
    return (async () => {
      try {
        const ctl = AbortSignal.timeout(timeoutMs);
        const r = await fetch(url, { method: 'POST', signal: ctl, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(def.headers || {}) }, body: JSON.stringify(init) });
        const txt = await r.text();
        if (r.status === 401 || r.status === 403) return { ok: false, ms: Date.now() - t0, error: `Signed out or not allowed (HTTP ${r.status}). Reconnect it in ${apps()[app].label}.` };
        if (!r.ok) return { ok: false, ms: Date.now() - t0, error: `HTTP ${r.status}` };
        const m = txt.match(/"serverInfo"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
        return { ok: true, ms: Date.now() - t0, server: m ? m[1] : null, note: 'Reachable and answering' };
      } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? `No answer in ${timeoutMs / 1000}s` : e.message }; }
    })();
  }
  return new Promise((resolve) => {
    let child; let buf = ''; let done = false; let stage = 0; let serverName = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve({ ms: Date.now() - t0, ...r }); };
    try { child = spawn(def.command, def.args || [], { env: { ...process.env, ...(def.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: plat === 'win32' && /\.(cmd|bat)$/i.test(def.command) }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const timer = setTimeout(() => finish({ ok: false, error: `No answer in ${timeoutMs / 1000}s` }), timeoutMs);
    child.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? `Program not found: ${path.basename(def.command)}` : e.message }));
    child.on('exit', (code) => finish({ ok: false, error: `It stopped straight away (exit code ${code})` }));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (stage === 0 && msg.id === 1) {
          if (msg.error) return finish({ ok: false, error: msg.error.message || 'initialize failed' });
          serverName = msg.result && msg.result.serverInfo && msg.result.serverInfo.name; stage = 1;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (stage === 1 && msg.id === 2) {
          const tools = (msg.result && msg.result.tools) || [];
          return finish({ ok: true, server: serverName, tools: tools.length, toolNames: tools.slice(0, 12).map((t) => t.name) });
        }
      }
    });
    child.stdin.write(JSON.stringify(init) + '\n');
  });
}

/** Command-line tools agents commonly need, and AI API keys present in the environment (names only). */
function localTools() {
  const which = (bin) => { const exts = plat === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']; for (const d of String(process.env.PATH || '').split(path.delimiter)) for (const e of exts) { const f = path.join(d, bin + e); if (d && fs.existsSync(f)) return f; } return null; };
  const list = [['claude', 'Claude Code'], ['codex', 'Codex'], ['git', 'Git'], ['gh', 'GitHub CLI'], ['node', 'Node.js'], ['python3', 'Python'], ['docker', 'Docker'], ['yt-dlp', 'yt-dlp (Fetcher)'], ['ffmpeg', 'ffmpeg (Fetcher)'], ['tailscale', 'Tailscale']];
  const tools = list.map(([bin, label]) => ({ bin, label, found: !!which(bin), path: which(bin) }));
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN'].map((k) => ({ name: k, set: !!process.env[k] }));
  return { tools, apiKeys: keys, note: 'Only whether a key is set is shown, never its value. Keys belong in your system environment or each app\'s settings, not in Cortex memory.' };
}

module.exports = { apps, inventory, share, unshare, check, localTools, readToml, tomlSection, publicDef };
