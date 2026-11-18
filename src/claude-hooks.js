'use strict';
// Claude Code integration: hooks that stream what Claude is doing into Cortex's live view,
// and deliver messages the user sends from their phone back into the running Claude session.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./sessions');

const CLI = path.resolve(__dirname, '..', 'bin', 'cortex.js');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SKILL_SRC = path.resolve(__dirname, '..', 'integrations', 'claude-code', 'SKILL.md');
const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', 'cortex', 'SKILL.md');
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const MARK = 'cortex.js" hook';

const q = (s) => `"${s}"`;
const hookCommand = (vault) => `${q(process.execPath)} ${q(CLI)} hook --vault ${q(vault)}`;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Could not parse ${SETTINGS}: ${e.message}`); }
}
const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(MARK);
function strip(cfg) {
  if (!cfg.hooks) return cfg;
  for (const ev of Object.keys(cfg.hooks)) {
    cfg.hooks[ev] = (cfg.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return cfg;
}
function writeSettings(cfg) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.cortex-backup');
  fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
}

function status() {
  let installed = false;
  try { installed = JSON.stringify(readSettings().hooks || {}).includes('cortex.js\\" hook'); } catch { /* ignore */ }
  return { installed, settingsFile: SETTINGS, skillInstalled: fs.existsSync(SKILL_DEST) };
}

function install({ vault }) {
  const cfg = strip(readSettings());
  cfg.hooks = cfg.hooks || {};
  const cmd = { type: 'command', command: hookCommand(vault), timeout: 10 };
  for (const ev of EVENTS) {
    cfg.hooks[ev] = cfg.hooks[ev] || [];
    cfg.hooks[ev].push(ev === 'PostToolUse' ? { matcher: '*', hooks: [cmd] } : { hooks: [cmd] });
  }
  writeSettings(cfg);
  try { fs.mkdirSync(path.dirname(SKILL_DEST), { recursive: true }); fs.copyFileSync(SKILL_SRC, SKILL_DEST); } catch { /* optional */ }
  return { ok: true, ...status(), backup: SETTINGS + '.cortex-backup' };
}

function uninstall() {
  writeSettings(strip(readSettings()));
  try { fs.rmSync(path.dirname(SKILL_DEST), { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: true, ...status() };
}

// ---------- the hook itself (runs inside Claude Code for every event; must be fast & never fail) ----------
function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  const cut = (s, n = 120) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  switch (name) {
    case 'Bash': return `$ ${cut(input.command)}`;
    case 'Edit': case 'MultiEdit': return `Edited ${base(input.file_path)}`;
    case 'Write': return `Wrote ${base(input.file_path)}`;
    case 'Read': return `Read ${base(input.file_path)}`;
    case 'NotebookEdit': return `Edited notebook ${base(input.notebook_path)}`;
    case 'Grep': return `Searched for "${cut(input.pattern, 60)}"`;
    case 'Glob': return `Listed files ${cut(input.pattern, 60)}`;
    case 'WebFetch': return `Fetched ${cut(input.url, 80)}`;
    case 'WebSearch': return `Web search: ${cut(input.query, 80)}`;
    case 'Task': case 'Agent': return `Started subagent: ${cut(input.description || input.prompt, 80)}`;
    case 'TodoWrite': {
      const todos = input.todos || [];
      const cur = todos.find((t) => t.status === 'in_progress');
      return cur ? `Working on: ${cut(cur.content || cur.activeForm, 100)}` : `Updated plan (${todos.length} items)`;
    }
    default: return name && name.startsWith('mcp__') ? `Used ${name.replace(/^mcp__/, '').replace(/__/g, ' → ')}` : `Used ${name}`;
  }
}

function formatMessages(msgs) {
  return 'The user sent you the following message(s) from their phone via Cortex. Read them and act on them:\n' + msgs.map((m) => `- ${m.text}`).join('\n');
}

function runHook(input, vault) {
  const ev = input.hook_event_name;
  if (!ev || !input.session_id) return null;
  const id = 'cc-' + sessions.safeId(input.session_id).slice(0, 40);
  const where = input.cwd ? path.basename(input.cwd) : '';
  const base = { agent: 'claude-code', cwd: input.cwd, workspace: where };
  const existing = sessions.get(vault, id);
  if (ev === 'UserPromptSubmit') {
    const prompt = String(input.prompt || '').replace(/\s+/g, ' ').trim();
    sessions.upsert(vault, id, { ...base, title: prompt.slice(0, 140) || (existing && existing.title) || 'Claude Code session', status: 'working', step: 'Thinking…', progress: null }, { kind: 'prompt', text: `▶ ${prompt.slice(0, 300)}` });
    const msgs = sessions.takeMessages(vault, id);
    return msgs.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: formatMessages(msgs) } } : null;
  }
  if (ev === 'PostToolUse') {
    const text = describeTool(input.tool_name, input.tool_input);
    sessions.upsert(vault, id, { ...base, status: 'working', step: text, ...(existing ? {} : { title: `Claude Code in ${where}` }) }, { kind: 'tool', text });
    const msgs = sessions.takeMessages(vault, id);
    return msgs.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: formatMessages(msgs) } } : null;
  }
  if (ev === 'Notification') {
    sessions.upsert(vault, id, { ...base, status: 'needs-you', step: String(input.message || 'Needs your attention') }, { kind: 'status', text: `⚠ ${input.message || 'Needs your attention'}` });
    return null;
  }
  if (ev === 'Stop') {
    if (!existing) return null;
    const msgs = sessions.takeMessages(vault, id);
    if (msgs.length && !input.stop_hook_active) {
      sessions.upsert(vault, id, { status: 'working', step: 'Reading your message…' });
      return { decision: 'block', reason: formatMessages(msgs) };
    }
    sessions.upsert(vault, id, { status: 'waiting', step: 'Finished. Waiting for your next instruction' }, { kind: 'status', text: '✓ Finished turn' });
    return null;
  }
  if (ev === 'SessionEnd') {
    if (existing) sessions.upsert(vault, id, { status: 'done', step: 'Session ended' }, { kind: 'status', text: 'Session ended' });
    return null;
  }
  return null;
}

module.exports = { install, uninstall, status, runHook, describeTool, hookCommand };
