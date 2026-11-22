'use strict';
// Command agents from Cortex.
//  1. Command queue: instructions for "any agent" or a named agent. Connected MCP agents receive them in
//     cortex_start / live_update / messages_check results and report back with command_complete.
//     Stored as files in <vault>/.cortex/commands so separate MCP processes can share them; an agent
//     claims a command by atomically creating <id>.claim, so two agents never take the same one.
//  2. Launcher: start Claude Code (`claude -p`) or Codex (`codex exec`) in an allowed folder with a prompt,
//     stream its progress into the Live view, and stop it on request.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const sessions = require('./sessions');
const claudeHooks = require('./claude-hooks');
const brief = require('./brief');

const now = () => new Date().toISOString();
const cmdDir = (vault) => path.join(vault, '.cortex', 'commands');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeAtomic(f, obj) { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, f); }

// ---------------- command queue ----------------
// `kind` and `task`/`replyTo` are set when one agent messages another (agent_send): request, handoff or info.
function createCommand(vault, { text, target, project, from, kind, task, replyTo }) {
  text = String(text || '').trim();
  if (!text) throw new Error('The instruction is empty');
  fs.mkdirSync(cmdDir(vault), { recursive: true });
  const cmd = { id: 'cmd-' + crypto.randomBytes(5).toString('hex'), ts: now(), target: String(target || 'any').trim() || 'any', text: text.slice(0, 8000), project: project || undefined, from: from || 'you', kind: kind || undefined, task: task || undefined, replyTo: replyTo || undefined, status: 'pending' };
  writeAtomic(path.join(cmdDir(vault), cmd.id + '.json'), cmd);
  return cmd;
}

function listCommands(vault, { limit = 100 } = {}) {
  let files = [];
  try { files = fs.readdirSync(cmdDir(vault)).filter((f) => /^cmd-[a-f0-9]+\.json$/.test(f)); } catch { return []; }
  return files.map((f) => readJson(path.join(cmdDir(vault), f))).filter(Boolean).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}

// Agents identify themselves differently (claude.ai checks in as "AnthropicClaudeAI", Claude Code as "claude-code"…).
// Commands match by family, so "send to Claude" reaches whichever Claude app checks in next.
function family(name) {
  const n = String(name || '').toLowerCase();
  if (/anthropic|claude/.test(n)) return 'claude';
  if (/openai|chatgpt|gpt|codex/.test(n)) return 'openai';
  if (/cursor/.test(n)) return 'cursor';
  return n;
}
const matches = (target, agent) => {
  const t = String(target || 'any').toLowerCase();
  if (t === 'any') return true;
  if (t === String(agent || '').toLowerCase()) return true;
  return family(t) === family(agent);
};

/** Claim pending commands for this agent (each command goes to exactly one agent). */
function claimCommands(vault, agent, max = 5) {
  const out = [];
  for (const c of listCommands(vault).reverse()) {
    if (out.length >= max) break;
    if (c.status !== 'pending' || !matches(c.target, agent)) continue;
    if (String(c.from || '').toLowerCase() === String(agent || '').toLowerCase()) continue; // never deliver an agent its own message
    try { fs.closeSync(fs.openSync(path.join(cmdDir(vault), c.id + '.claim'), 'wx')); } catch { continue; }
    const taken = { ...c, status: 'taken', takenBy: agent, takenAt: now() };
    writeAtomic(path.join(cmdDir(vault), c.id + '.json'), taken);
    out.push(taken);
  }
  return out;
}

function completeCommand(vault, id, { result, failed }, agent) {
  const f = path.join(cmdDir(vault), String(id).replace(/[^\w-]/g, '') + '.json');
  const c = readJson(f);
  if (!c) throw new Error(`Unknown command "${id}"`);
  const done = { ...c, status: failed ? 'failed' : 'done', result: String(result || '').slice(0, 8000), doneAt: now(), takenBy: c.takenBy || agent };
  writeAtomic(f, done);
  return done;
}

function deleteCommand(vault, id) {
  const base = path.join(cmdDir(vault), String(id).replace(/[^\w-]/g, ''));
  fs.rmSync(base + '.json', { force: true });
  fs.rmSync(base + '.claim', { force: true });
}

const fromUser = (c) => /^you\b/i.test(String(c.from || 'you'));
const commandView = (c) => ({ id: c.id, instruction: c.text, project: c.project, from: c.from, sent: c.ts, ...(c.kind ? { kind: c.kind } : {}), ...(c.task ? { task: c.task } : {}), ...(c.replyTo ? { reply_to: c.replyTo } : {}) });

/** Claim waiting commands and split them: from the user (dashboard/phone) vs from other agents (agent_send). */
function claimInbox(vault, agent, max = 5) {
  const all = claimCommands(vault, agent, max);
  return { fromUser: all.filter(fromUser).map(commandView), fromAgents: all.filter((c) => !fromUser(c)).map(commandView) };
}

/**
 * Results of messages this agent sent to other agents that have since been completed. Each reply is
 * delivered once (marked replyDelivered), so the sender learns the outcome without polling the dashboard.
 */
function takeReplies(vault, agent, max = 10) {
  const me = String(agent || '').toLowerCase();
  const out = [];
  for (const c of listCommands(vault, { limit: 500 }).reverse()) {
    if (out.length >= max) break;
    if (String(c.from || '').toLowerCase() !== me || c.replyDelivered || !['done', 'failed'].includes(c.status)) continue;
    writeAtomic(path.join(cmdDir(vault), c.id + '.json'), { ...c, replyDelivered: now() });
    out.push({ id: c.id, to: c.target, answered_by: c.takenBy, status: c.status, your_message: c.text.slice(0, 300), result: c.result, task: c.task, finished: c.doneAt });
  }
  return out;
}

/** Messages this agent sent and their state (pending, taken, done, failed). */
function sentBy(vault, agent, limit = 20) {
  const me = String(agent || '').toLowerCase();
  return listCommands(vault, { limit: 500 }).filter((c) => String(c.from || '').toLowerCase() === me).slice(0, limit)
    .map((c) => ({ id: c.id, to: c.target, kind: c.kind, status: c.status, taken_by: c.takenBy, message: c.text.slice(0, 200), result: c.result, sent: c.ts }));
}

/**
 * Who else is working with Cortex: agents seen in live sessions and the activity log, newest first,
 * with their family (so "claude" / "openai" targets are obvious), last project and current step.
 */
function peers(store, { hours = 72, self } = {}) {
  const since = Date.now() - hours * 3600e3;
  const byName = new Map();
  const see = (name, ts, extra = {}) => {
    if (!name || /^you\b/i.test(name) || name === 'cortex') return;
    const t = Date.parse(ts) || 0;
    if (t < since) return;
    const p = byName.get(name) || { agent: name, family: family(name), last_seen: ts, actions: 0 };
    if (t >= (Date.parse(p.last_seen) || 0)) { p.last_seen = ts; Object.assign(p, extra); }
    byName.set(name, p);
    return p;
  };
  for (const a of store.recentActivity({ limit: 400 }) || []) { const p = see(a.agent, a.ts, a.project ? { project: a.project } : {}); if (p) p.actions++; }
  for (const s of sessions.list(store.vault) || []) {
    see(s.agent, s.updated || s.started, { live: s.status, step: s.step, project: s.project || undefined, session: s.id });
  }
  return [...byName.values()].map((p) => ({ ...p, you: self && p.agent.toLowerCase() === String(self).toLowerCase() ? true : undefined }))
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
}

// ---------------- launcher ----------------
const which = (bin) => new Promise((res) => execFile(process.platform === 'win32' ? 'where' : 'which', [bin], (e, out) => res(e ? null : String(out).split(/\r?\n/)[0].trim() || null)));

const os = require('os');
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
// Usual install locations, so Cortex finds the CLIs even when they aren't on the PATH it was started with.
const CANDIDATES = {
  claude: process.platform === 'win32'
    ? [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(APPDATA, 'npm', 'claude.cmd'), path.join(HOME, '.claude', 'local', 'claude.exe'), path.join(HOME, '.claude', 'local', 'claude.cmd'), path.join(LOCALAPPDATA, 'Programs', 'claude-code', 'claude.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'claude.cmd')]
    : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude', path.join(HOME, '.npm-global', 'bin', 'claude'), path.join(HOME, '.bun', 'bin', 'claude')],
  codex: process.platform === 'win32'
    ? [path.join(APPDATA, 'npm', 'codex.cmd'), path.join(HOME, '.local', 'bin', 'codex.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'codex.cmd')]
    : [path.join(HOME, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex', path.join(HOME, '.npm-global', 'bin', 'codex')],
};
const INSTALL_HELP = {
  claude: process.platform === 'win32'
    ? 'Install Claude Code: open PowerShell and run  irm https://claude.ai/install.ps1 | iex  (or, with Node.js: npm install -g @anthropic-ai/claude-code). Then run  claude  once to sign in, and click "Check again".'
    : 'Install Claude Code: run  curl -fsSL https://claude.ai/install.sh | bash  (or npm install -g @anthropic-ai/claude-code). Then run  claude  once to sign in, and click "Check again".',
  codex: 'Install Codex: npm install -g @openai/codex, then run  codex  once to sign in, and click "Check again".',
};
// The Codex desktop app (Microsoft Store) ships the CLI inside its package folder, whose name changes with
// every update. WindowsApps can't be listed, so ask Windows where the package lives (cached for 10 minutes).
let storeCodex = { at: 0, path: null };
function windowsAppCodex() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (Date.now() - storeCodex.at < 600e3) return Promise.resolve(storeCodex.path);
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],
  { windowsHide: true, timeout: 15000 }, (e, out) => {
    const dir = e ? '' : String(out).trim();
    const exe = dir ? path.join(dir, 'app', 'resources', 'codex.exe') : null;
    storeCodex = { at: Date.now(), path: exe && fs.existsSync(exe) ? exe : null };
    res(storeCodex.path);
  }));
}
const TOOLS = {
  claude: { label: 'Claude Code', agent: 'claude-code', env: 'CORTEX_CLAUDE_BIN', name: 'claude' },
  codex: { label: 'Codex', agent: 'codex', env: 'CORTEX_CODEX_BIN', name: 'codex' },
};

function spawnAgent(bin, args, options) {
  const win = process.platform === 'win32';
  const nodeWrapper = /\.js$/i.test(bin);
  const commandScript = win && /\.(?:cmd|bat)$/i.test(bin);
  if (nodeWrapper) return spawn(process.execPath, [bin, ...args], options);
  if (!commandScript) return spawn(bin, args, options);
  const quoted = args.map((arg) => /[\s*]/.test(arg) ? '"' + arg + '"' : arg);
  return spawn('"' + bin + '"', quoted, { ...options, shell: true });
}

class AgentRunner {
  constructor(store) { this.store = store; this.vault = store.vault; this.procs = new Map(); this.resolved = {}; }

  /** Find each CLI: custom path from Settings → env var → PATH → usual install folders. */
  async available() {
    const conf = require('./settings').load(this.vault).agents;
    const out = {};
    for (const [k, t] of Object.entries(TOOLS)) {
      const custom = conf[k + 'Path'] || process.env[t.env];
      let found = null;
      if (custom) found = fs.existsSync(custom) ? custom : null;
      if (!found) { const w = await which(t.name); if (w && fs.existsSync(w)) found = w; }
      if (!found) found = CANDIDATES[k].find((c) => fs.existsSync(c)) || null;
      if (!found && k === 'codex') found = await windowsAppCodex();
      this.resolved[k] = found;
      out[k] = { label: t.label, installed: !!found, path: found, custom: custom || null, help: found ? null : INSTALL_HELP[k] };
    }
    return out;
  }
  bin(tool) { return this.resolved[tool] || process.env[TOOLS[tool].env] || TOOLS[tool].name; }

  /** Run a CLI briefly and collect its output (stdin closed straight away, so nothing waits for input). */
  runQuick(bin, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
      let out = ''; let err = ''; let done = false;
      const child = spawnAgent(bin, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {}); child.stdin.end();
      child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch { /* gone */ } resolve({ code: null, out, err, timedOut: true }); } }, timeoutMs);
      child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: e.message }); } });
      child.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
    });
  }

  /** Is the CLI found, which version, and is it signed in? (makes one tiny request to check sign-in) */
  async check(tool = 'claude') {
    const avail = (await this.available())[tool];
    if (!avail) throw new Error(`Unknown tool "${tool}"`);
    const res = { tool, label: avail.label, found: avail.installed, path: avail.path, version: null, signedIn: null, detail: '' };
    if (!avail.installed) { res.detail = avail.help; return res; }
    const v = await this.runQuick(avail.path, ['--version'], this.vault, 20000);
    res.version = (v.out || v.err).trim().split(/\r?\n/)[0] || null;
    if (v.code !== 0 && !res.version) { res.detail = `Found, but it would not start: ${(v.err || 'unknown error').trim().slice(0, 300)}`; return res; }
    if (tool !== 'claude') { res.detail = 'Found. Sign-in is checked the first time it runs.'; return res; }
    // `claude auth status` answers instantly with JSON and doesn't start a session (so no hooks run).
    // The Claude desktop app signs in separately: the CLI needs its own sign-in.
    const a = await this.runQuick(avail.path, ['auth', 'status'], this.vault, 20000);
    let auth = null;
    try { auth = JSON.parse(String(a.out).slice(String(a.out).indexOf('{'))); } catch { /* older CLI without auth status */ }
    if (auth && auth.loggedIn === false && !process.env.ANTHROPIC_API_KEY) {
      res.signedIn = false;
      res.detail = 'Not signed in. The Claude desktop app signs in separately from the claude command. Open PowerShell, run:  claude auth login  (or run "claude" and type /login), finish in the browser, then press Test again.';
      return res;
    }
    const r = await this.runQuick(avail.path, ['-p', 'Reply with exactly: CORTEX-OK', '--output-format', 'json'], this.vault, 90000);
    let result = null;
    for (const line of String(r.out).split(/\r?\n/).reverse()) { try { const j = JSON.parse(line); if (j && (j.type === 'result' || j.result !== undefined)) { result = j; break; } } catch { /* not json */ } }
    if (!result) { try { result = JSON.parse(r.out); } catch { /* not json */ } }
    const text = [result && result.result, r.err, r.out].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (r.timedOut) { res.signedIn = null; res.detail = 'Claude Code started but did not answer within 90 s. It may be waiting for a first-time sign-in: run "claude" once in a terminal.'; }
    else if (result && !result.is_error && r.code === 0) { res.signedIn = true; res.detail = 'Signed in and working. Cortex can start it.'; }
    else { res.signedIn = false; res.detail = /log ?in|auth|api key|credential|sign in|unauthori/i.test(text) ? `Not signed in. Open a terminal, run "claude" and sign in, then test again. (${text.slice(0, 200)})` : `It ran but returned an error: ${text.slice(0, 300) || 'exit code ' + r.code}`; }
    return res;
  }

  running() { return [...this.procs.keys()]; }

  launch({ tool = 'claude', prompt, cwd, permission = 'acceptEdits', maxMinutes = 120, project, task, resume, continues, from, model, briefText }) {
    const t = TOOLS[tool];
    if (!t) throw new Error(`Unknown agent tool "${tool}"`);
    model = cleanModel(model);
    prompt = String(prompt || '').trim();
    if (!prompt && !task) throw new Error('Tell the agent what to do');
    if (resume && tool !== 'claude') throw new Error('Only Claude Code runs can be continued');
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Folder not found: ${cwd}`);
    if (this.procs.size >= 4) throw new Error('Already running 4 agents. Stop one first.');
    const id = 'run-' + crypto.randomBytes(5).toString('hex');
    const hooks = tool === 'claude' && claudeHooks.status().installed;
    // Every launched agent gets the Cortex brief: standing + project instructions, open tasks, memories, rules.
    // briefText: a job from another computer's Cortex arrives with that Cortex's brief already built.
    const b = resume ? { text: prompt, project, task } : briefText ? { text: String(briefText), project, task } : brief.buildBrief(this.store, { project, task, assignment: prompt, runId: id });
    const taskRec = b.task ? this.store.get(b.task) : null;
    const title = (prompt || (taskRec && taskRec.title) || '').replace(/\s+/g, ' ').slice(0, 140);
    let args;
    if (tool === 'claude') {
      // Documented pattern: piped stdin is the material, the -p argument is the instruction (fixed text, never user input).
      args = ['-p', 'Follow the Cortex brief and assignment provided on stdin.', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__cortex__*', 'mcp__claude_ai_cortex'];
      if (resume) args.push('--resume', String(resume).replace(/[^\w-]/g, ''));
      if (['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(permission)) args.push('--permission-mode', permission);
      if (model) args.push('--model', model);
    } else {
      args = ['exec', '--skip-git-repo-check', '--json'];
      if (permission === 'acceptEdits') args.push('--full-auto');
      if (permission === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
      if (model) args.push('-m', model);
      args.push('-');
    }
    sessions.upsert(this.vault, id, { agent: t.agent, title, status: 'working', step: `Starting ${t.label}${model ? ` (${model})` : ''}…`, cwd, workspace: path.basename(cwd), launched: true, tool, permission, project: b.project, task: b.task, prompt: prompt.slice(0, 4000), continues, from, ...(model ? { model } : {}) }, { kind: 'prompt', text: `▶ ${(prompt || title).slice(0, 400)}` });
    // The task shows its model straight away (what was asked for), corrected to the real one when the agent reports it.
    const expected = model || (tool === 'codex' ? require('./models').codexDefaultModel() : undefined);
    if (taskRec && taskRec.meta.status !== 'done') this.store.update(taskRec.id, { status: 'doing', assignee: t.agent, ...(expected ? { model: expected, model_agent: t.agent } : {}) });
    if (expected) sessions.upsert(this.vault, id, { model: expected });
    const win = process.platform === 'win32';
    // The prompt goes through stdin, never through a shell command line.
    const child = spawnAgent(this.bin(tool), args, { cwd, env: { ...process.env, CORTEX_RUN_ID: id }, detached: !win, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rec = { child, id, tool, stderr: [], ended: false, stopped: false, project: b.project, task: b.task, prompt: prompt || title, agent: t.agent, started: Date.now() };
    this.procs.set(id, rec);
    child.stdin.on('error', () => {});
    child.stdin.end(b.text + '\n');
    const timer = setTimeout(() => { sessions.upsert(this.vault, id, {}, { kind: 'status', text: `Time limit of ${maxMinutes} min reached` }); this.stop(id); }, maxMinutes * 60000);
    timer.unref();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.onLine(rec, line, hooks); }
    });
    child.stderr.on('data', (d) => { rec.stderr.push(...String(d).split(/\r?\n/).filter(Boolean)); if (rec.stderr.length > 30) rec.stderr = rec.stderr.slice(-30); });
    child.on('error', (e) => this.finish(rec, 1, e.code === 'ENOENT' ? `${t.label} is not installed or not on PATH` : e.message));
    child.on('exit', (code) => { clearTimeout(timer); if (buf.trim()) this.onLine(rec, buf.trim(), hooks); this.finish(rec, code); });
    return { id };
  }

  onLine(rec, line, hooks) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (rec.tool === 'codex') {
      if (ev.type === 'turn.completed') { this.recordUsage(rec, ev.usage); if (!rec.model) this.stampModel(rec, require('./models').codexModelSince(rec.started)); }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        rec.summary = ev.item.text;
        sessions.upsert(this.vault, rec.id, { step: rec.summary.slice(0, 200) }, { kind: 'say', text: rec.summary.slice(0, 500) });
      }
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      sessions.upsert(this.vault, rec.id, { claude_session: ev.session_id, model: ev.model }, { kind: 'status', text: `Started${ev.model ? ` (${ev.model})` : ''}` });
      this.stampModel(rec, ev.model);
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) {
          const txt = c.text.replace(/\s+/g, ' ').trim();
          sessions.upsert(this.vault, rec.id, { step: txt.slice(0, 200) }, { kind: 'say', text: txt.slice(0, 500) });
        } else if (c.type === 'tool_use' && !hooks) {
          const d = claudeHooks.describeTool(c.name, c.input);
          sessions.upsert(this.vault, rec.id, { step: d }, { kind: 'tool', text: d });
        }
      }
    } else if (ev.type === 'result') {
      rec.result = ev;
      this.recordUsage(rec, ev.usage);
    }
  }

  recordUsage(rec, raw) {
    const valid = (n) => Number.isSafeInteger(n) && n >= 0;
    if (!raw || !valid(raw.input_tokens) || !valid(raw.output_tokens)) return;
    const count = (n) => valid(n) ? n : 0;
    const usage = rec.usage || { input: 0, output: 0, cachedInput: 0 };
    usage.input += raw.input_tokens;
    usage.output += raw.output_tokens;
    if (rec.tool === 'claude') {
      usage.input += count(raw.cache_creation_input_tokens) + count(raw.cache_read_input_tokens);
      usage.cachedInput += count(raw.cache_read_input_tokens);
    } else usage.cachedInput += count(raw.cached_input_tokens);
    rec.usage = usage;
    sessions.upsert(this.vault, rec.id, { usage });
  }

  /** The real model of a run, on its Live card and its task. */
  stampModel(rec, model) {
    const m = require('./models').cleanModelName(model);
    if (!m) return;
    rec.model = m;
    sessions.upsert(this.vault, rec.id, { model: m });
    try { if (rec.task && this.store.get(rec.task)) this.store.update(rec.task, { model: m, model_agent: rec.agent }); } catch { /* task gone */ }
  }

  finish(rec, code, error) {
    if (rec.ended) return;
    rec.ended = true;
    this.procs.delete(rec.id);
    // Codex doesn't print its model; its own session log has it.
    if (rec.tool === 'codex' && !rec.reportedModel) this.stampModel(rec, require('./models').codexModelSince(rec.started));
    try { this.settle(rec, code, error); } finally {
      const s = sessions.get(this.vault, rec.id) || {};
      try { brief.recordOutcome(this.store, { project: rec.project, task: rec.task, agent: rec.agent, prompt: rec.prompt, status: rec.stopped ? 'stopped' : s.status, result: s.result || s.step, runId: rec.id, files: s.files, commands: s.commands, savedMemory: s.saved }); } catch { /* best effort */ }
    }
  }

  settle(rec, code, error) {
    const r = rec.result;
    if (rec.stopped) {
      sessions.upsert(this.vault, rec.id, { status: 'done', step: 'Stopped by you' }, { kind: 'status', text: '■ Stopped by you' });
    } else if (r && !r.is_error && (!r.subtype || r.subtype === 'success') && !error) {
      const summary = String(r.result || '').trim();
      sessions.upsert(this.vault, rec.id, { status: 'done', step: summary ? summary.replace(/\s+/g, ' ').slice(0, 200) : 'Finished', result: summary.slice(0, 4000), cost_usd: r.total_cost_usd, turns: r.num_turns }, { kind: 'status', text: `✓ Finished${r.num_turns ? ` in ${r.num_turns} turns` : ''}` });
    } else if (code === 0 && !error && rec.tool !== 'claude') {
      sessions.upsert(this.vault, rec.id, { status: 'done', step: 'Finished', result: rec.summary?.slice(0, 4000) }, { kind: 'status', text: '✓ Finished' });
    } else {
      const why = error || (r && r.result) || rec.stderr.slice(-3).join(' ') || `exited with code ${code}`;
      sessions.upsert(this.vault, rec.id, { status: 'error', step: String(why).slice(0, 200) }, { kind: 'status', text: `✗ ${String(why).slice(0, 400)}` });
    }
  }

  stop(id) {
    const rec = this.procs.get(id);
    if (!rec) return false;
    rec.stopped = true;
    try {
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(rec.child.pid), '/T', '/F'], () => {});
      else process.kill(-rec.child.pid, 'SIGTERM');
    } catch { try { rec.child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { if (!rec.ended) { try { process.platform === 'win32' ? rec.child.kill() : process.kill(-rec.child.pid, 'SIGKILL'); } catch { /* gone */ } } }, 4000).unref();
    return true;
  }

  stopAll() { for (const id of this.running()) this.stop(id); }
}

/** Is `dir` inside one of the allowed folders? */
function folderAllowed(dir, allowed) {
  if (!dir) return false;
  const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  const candidate = realPath(dir);
  if (!candidate) return false;
  return (allowed || []).some((folder) => {
    const root = realPath(folder);
    if (!root) return false;
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
}

// Model choice for launched agents. Claude Code accepts aliases (opus, sonnet, haiku) or full model names via --model;
// Codex accepts its model names via -m. Only plain model-name characters are passed on (no spaces, no flags).
const MODELS = { claude: ['opus', 'sonnet', 'haiku'], codex: [] };
function cleanModel(m) {
  const s = String(m || '').trim();
  if (!s || /^(default|auto)$/i.test(s)) return undefined;
  if (!/^[A-Za-z0-9][\w.:\-[\]]{0,79}$/.test(s)) throw new Error(`"${s}" doesn't look like a model name (letters, numbers, . - _ : only)`);
  return s;
}
// What a run should use: explicit choice first, then the project's defaults (model only if the agent matches).
function pickAgent(projectMeta, tool, model) {
  const pm = projectMeta || {};
  const t = tool || pm.agent_tool || 'claude';
  const m = model !== undefined && String(model).trim() !== '' ? model : ((pm.agent_tool || 'claude') === t ? pm.agent_model : undefined);
  return { tool: t, model: cleanModel(m) };
}

module.exports = { MODELS, cleanModel, pickAgent, family, createCommand, listCommands, claimCommands, claimInbox, takeReplies, sentBy, peers, completeCommand, deleteCommand, commandView, AgentRunner, folderAllowed, TOOLS };
