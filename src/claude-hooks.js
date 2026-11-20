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
// Documented Claude Code hook events. Timeouts are in seconds.
const EVENTS = { SessionStart: 20, UserPromptSubmit: 20, PostToolUse: 10, Notification: 10, PermissionRequest: 150, Stop: 20, SessionEnd: 5 };
const MATCHER = { PostToolUse: '*' };
const MARK = 'cortex.js" hook';

const q = (s) => `"${s}"`;
// Claude Code runs hook commands through a shell: Git Bash on Windows when installed, otherwise PowerShell.
// PowerShell can't parse a line that STARTS with a quoted path ("C:\Program Files\nodejs\node.exe" …
// → "Unexpected token"), so on Windows start with a bare program name, which bash, cmd and PowerShell
// all accept.
function nodeOnPath() {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const want = path.dirname(process.execPath).toLowerCase().replace(/[\\/]+$/, '');
  return dirs.some((d) => path.resolve(d).toLowerCase().replace(/[\\/]+$/, '') === want);
}
function nodeForShell() {
  if (process.platform !== 'win32') return q(process.execPath);
  if (!/\s/.test(process.execPath)) return process.execPath;
  if (nodeOnPath()) return 'node';
  return `& ${q(process.execPath)}`; // PowerShell call operator (no Git Bash on this PC)
}
const hookCommand = (vault) => `${nodeForShell()} ${q(CLI)} hook --vault ${q(vault)}`;

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
  for (const [ev, timeout] of Object.entries(EVENTS)) {
    const cmd = { type: 'command', command: hookCommand(vault), timeout };
    cfg.hooks[ev] = cfg.hooks[ev] || [];
    cfg.hooks[ev].push(MATCHER[ev] ? { matcher: MATCHER[ev], hooks: [cmd] } : { hooks: [cmd] });
  }
  writeSettings(cfg);
  // the cortex skill is only written if you don't already have your own skill called "cortex"
  try {
    const dir = path.dirname(SKILL_DEST);
    if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, '.cortex-managed'))) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(SKILL_SRC, SKILL_DEST);
      fs.writeFileSync(path.join(dir, '.cortex-managed'), 'Installed by Cortex.\n');
    }
  } catch { /* optional */ }
  return { ok: true, ...status(), backup: SETTINGS + '.cortex-backup' };
}

// Re-write our hooks if they are missing events or use an old command line (e.g. the pre-1.2.3 form that
// PowerShell can't run, or a moved vault/install folder). Never touches the user's own hooks.
function repair({ vault }) {
  let cfg;
  try { cfg = readSettings(); } catch { return { repaired: false }; }
  const ours = [];
  for (const [ev, groups] of Object.entries(cfg.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) if (isOurs(h)) ours.push([ev, h.command]);
  if (!ours.length) return { repaired: false };
  // Only fix hooks that already belong to THIS vault. Any other Cortex (a test server, a second vault)
  // must never re-point the user's hooks at itself; that is what `cortex hooks install` is for.
  const norm = (p) => path.resolve(String(p || '')).toLowerCase();
  const vaultOf = (c) => { const m = String(c).match(/--vault\s+"([^"]+)"|--vault\s+(\S+)/); return m ? (m[1] || m[2]) : null; };
  if (!ours.every(([, c]) => vaultOf(c) && norm(vaultOf(c)) === norm(vault))) return { repaired: false, reason: 'hooks belong to another vault' };
  const want = hookCommand(vault);
  const events = new Set(ours.map(([ev]) => ev));
  if (ours.every(([, c]) => c === want) && Object.keys(EVENTS).every((e) => events.has(e))) return { repaired: false };
  install({ vault });
  return { repaired: true };
}

function uninstall() {
  writeSettings(strip(readSettings()));
  try { const dir = path.dirname(SKILL_DEST); if (fs.existsSync(path.join(dir, '.cortex-managed'))) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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

function commandsText(vault) {
  try {
    const agents = require('./agents');
    const { fromUser, fromAgents } = agents.claimInbox(vault, 'claude-code');
    const replies = agents.takeReplies(vault, 'claude-code');
    const line = (c) => `- [${c.id}]${c.project ? ` (project ${c.project})` : ''}${c.task ? ` (task ${c.task})` : ''} ${c.instruction}`;
    const out = [];
    if (fromUser.length) out.push('The user sent you these commands through Cortex. Do them now (unless the user says otherwise), then report each one with command_complete (id + result):\n' + fromUser.map(line).join('\n'));
    if (fromAgents.length) out.push('Other AI agents working with Cortex sent you these messages. Treat them as requests from a colleague (the user\'s instructions win), and answer each with command_complete (id + result):\n' + fromAgents.map((c) => line(c).replace('- [', `- from ${c.from}${c.kind ? ` (${c.kind})` : ''} [`)).join('\n'));
    if (replies.length) out.push('Replies to messages you sent other agents through Cortex:\n' + replies.map((r) => `- ${r.answered_by || r.to} ${r.status === 'failed' ? 'could not do' : 'answered'} [${r.id}] "${clip(r.your_message, 80)}": ${r.result}`).join('\n'));
    return out.join('\n\n');
  } catch { return ''; }
}

function formatMessages(msgs) {
  return 'The user sent you the following message(s) from their phone via Cortex. Read them and act on them:\n' + msgs.map((m) => `- ${m.text}`).join('\n');
}

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Cortex tools arrive under different server names: "mcp__cortex__…" (local stdio/HTTP), "mcp__claude_ai_cortex__…"
// (claude.ai connector), "mcp__claude_ai_cortex_2___…" (a second connector), "mcp__plugin_…_cortex__…".
const SAVE_TOOLS = /^mcp__\w*?cortex\w*?__(memory_write|memory_update|mind_complete|activity_log|skill_save)$/i;
// The Claude desktop app names connectors by id (mcp__300816c3-…__memory_write), with no "cortex" in it.
// For those, also accept the save when the tool's reply has Cortex's shape (a vault id or an activity entry).
const SAVE_NAMES = /^mcp__.+__(memory_write|memory_update|mind_complete|activity_log|skill_save)$/;
function isCortexSave(input) {
  const name = String(input.tool_name || '');
  if (SAVE_TOOLS.test(name)) return true;
  if (!SAVE_NAMES.test(name)) return false;
  let reply = input.tool_response;
  try { reply = typeof reply === 'string' ? reply : JSON.stringify(reply); } catch { reply = ''; }
  // replies can arrive wrapped in a text block, so quotes may be escaped (\"id\")
  return /\\?"id\\?"\s*:\s*\\?"(notes|tasks|projects|mind|skills)\/|\\?"(agent|ts)\\?"\s*:\s*\\?"/.test(String(reply || ''));
}
const CHANGE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function loadStore(vault) { const { Store } = require('./store'); return new Store(vault); }

function sessionContext(vault, cwd, source) {
  const journal = require('./journal');
  const brief = require('./brief');
  const project = journal.projectForFolder(vault, cwd);
  const store = loadStore(vault);
  const b = brief.buildBrief(store, { project });
  const header = project
    ? `[Cortex] This folder belongs to the Cortex project "${project}". Below is its brief: the user's instructions, this project's memories (they apply only to this project), system memories (they apply to every project) and recent agent work. Build on it. Cortex records what you do in notes/${project}/agent-journal.md automatically; you must still save what you learn with memory_write (project "${project}").`
    : '[Cortex] This folder is not linked to a Cortex project, so only system memories are loaded. Link it by setting the project\'s "folder" in Cortex.';
  return { project, text: clip(`${header}\n\n${b.text}`, 9500) };
}

// A project named in the prompt ("my recall-test project") counts when the folder itself isn't linked to one.
function mentionedProject(store, prompt) {
  const text = ` ${String(prompt).toLowerCase()} `;
  let best = null;
  for (const r of store.items.values()) {
    if (r.kind !== 'project') continue;
    for (const name of [r.slug, r.title].filter((n) => n && n.length >= 3)) {
      const esc = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text) && (!best || name.length > best.len)) best = { slug: r.slug, len: name.length };
    }
  }
  return best && best.slug;
}

function recall(vault, project, prompt) {
  const store = loadStore(vault);
  project = project || mentionedProject(store, prompt);
  const f = project ?{ scope: 'project+system', projectScope: project } : { scope: 'system' };
  const hits = store.search(prompt, { kind: 'note', limit: 5, minMatch: 1, ...f }).filter((h) => !h.rec.meta.agent_journal && h.score >= 6);
  if (!hits.length) return '';
  return clip('[Cortex] Memories related to this request (read the full note with memory_get if relevant):\n' + hits.map((h) => `- ${h.rec.title} (${h.rec.id}${h.rec.meta.project ? '' : ', system'}): ${h.snippet}`).join('\n'), 3500);
}

async function waitForApproval(vault, sid, input) {
  const settings = require('./settings').load(vault);
  if (!settings.agents.phoneApprovals) return null; // normal permission dialog on the computer
  const dir = path.join(vault, '.cortex', 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'ap-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const f = path.join(dir, id + '.json');
  const req = { id, session: sid, tool: input.tool_name, summary: describeTool(input.tool_name, input.tool_input || {}), input: clip(JSON.stringify(input.tool_input || {}), 2000), cwd: input.cwd, ts: new Date().toISOString(), status: 'pending' };
  fs.writeFileSync(f, JSON.stringify(req));
  sessions.upsert(vault, sid, { status: 'needs-you', step: `Waiting for your approval: ${req.summary}`, approval: id }, { kind: 'status', text: `🔐 Asked to: ${req.summary}` });
  const wait = Math.max(10, Math.min(140, Number(settings.agents.approvalWaitSeconds) || 120)) * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    await new Promise((r) => setTimeout(r, 700));
    let cur;
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (cur.status === 'allow' || cur.status === 'deny') {
      sessions.upsert(vault, sid, { status: 'working', step: cur.status === 'allow' ? `Approved: ${req.summary}` : 'Denied by you', approval: null }, { kind: 'status', text: cur.status === 'allow' ? '✓ You approved from Cortex' : '✗ You denied from Cortex' });
      return cur.status === 'allow'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
        : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: cur.note ? `The user denied this from Cortex: ${cur.note}` : 'The user denied this from Cortex.' } } };
    }
  }
  try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.status === 'pending') fs.writeFileSync(f, JSON.stringify({ ...cur, status: 'expired' })); } catch { /* ignore */ }
  sessions.upsert(vault, sid, { approval: null }, { kind: 'status', text: 'No answer from Cortex in time; asking on the computer instead' });
  return null; // fall back to the normal dialog
}

async function runHook(input, vault) {
  const ev = input.hook_event_name;
  if (!ev || !input.session_id) return null;
  // Agents launched from Cortex carry CORTEX_RUN_ID so their hooks report into the same Live card.
  const launched = !!process.env.CORTEX_RUN_ID;
  const id = launched ? sessions.safeId(process.env.CORTEX_RUN_ID) : 'cc-' + sessions.safeId(input.session_id).slice(0, 40);
  const where = input.cwd ? path.basename(input.cwd) : '';
  const base = { agent: 'claude-code', cwd: input.cwd, workspace: where };
  const existing = sessions.get(vault, id);
  const settings = require('./settings').load(vault);

  if (ev === 'SessionStart') {
    const ctx = sessionContext(vault, input.cwd, input.source);
    sessions.upsert(vault, id, { ...base, project: ctx.project, ...(existing ? {} : { title: `Claude Code in ${where}`, status: 'waiting', step: 'Session started' }) }, { kind: 'status', text: `Session ${input.source || 'started'}${ctx.project ? ` · project ${ctx.project}` : ''} · Cortex brief loaded` });
    const cmds = commandsText(vault);
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: (cmds ? cmds + '\n\n' : '') + ctx.text } };
  }
  if (ev === 'UserPromptSubmit') {
    const prompt = String(input.prompt || '').replace(/\s+/g, ' ').trim();
    const project = (existing && existing.project) || require('./journal').projectForFolder(vault, input.cwd);
    // each prompt starts a new "turn": reset what we track for the journal and the save gate
    sessions.upsert(vault, id, { ...base, project, title: prompt.slice(0, 140) || (existing && existing.title) || 'Claude Code session', status: 'working', step: 'Thinking…', progress: null, turnPrompt: prompt.slice(0, 600), files: [], commands: 0, saved: false, gateUsed: false }, { kind: 'prompt', text: `▶ ${prompt.slice(0, 300)}` });
    const parts = [];
    try { const r = recall(vault, project, prompt); if (r) parts.push(r); } catch { /* recall is best effort */ }
    const msgs = sessions.takeMessages(vault, id);
    if (msgs.length) parts.push(formatMessages(msgs));
    const cmds = commandsText(vault);
    if (cmds) parts.push(cmds);
    return parts.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } } : null;
  }
  if (ev === 'PostToolUse') {
    const text = describeTool(input.tool_name, input.tool_input);
    const cur = existing || {};
    const patch = { ...base, status: 'working', step: text, ...(existing ? {} : { title: `Claude Code in ${where}` }) };
    const ti = input.tool_input || {};
    if (CHANGE_TOOLS.has(input.tool_name)) patch.files = [...new Set([...(cur.files || []), path.basename(String(ti.file_path || ti.notebook_path || ''))].filter(Boolean))].slice(-60);
    if (input.tool_name === 'Bash') patch.commands = (cur.commands || 0) + 1;
    if (isCortexSave(input)) patch.saved = true;
    sessions.upsert(vault, id, patch, { kind: 'tool', text });
    const msgs = sessions.takeMessages(vault, id);
    return msgs.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: formatMessages(msgs) } } : null;
  }
  if (ev === 'PermissionRequest') {
    if (!existing) sessions.upsert(vault, id, { ...base, title: `Claude Code in ${where}` });
    return waitForApproval(vault, id, input);
  }
  if (ev === 'Notification') {
    const type = input.notification_type || '';
    const needs = /permission|idle|input|elicitation/.test(type) || !type;
    sessions.upsert(vault, id, { ...base, ...(needs ? { status: 'needs-you' } : {}), step: String(input.message || 'Needs your attention') }, { kind: 'status', text: `⚠ ${input.message || 'Needs your attention'}` });
    return null;
  }
  if (ev === 'Stop') {
    if (!existing) return null;
    const msgs = sessions.takeMessages(vault, id);
    if (msgs.length && !input.stop_hook_active) {
      sessions.upsert(vault, id, { status: 'working', step: 'Reading your message…' });
      return { decision: 'block', reason: formatMessages(msgs) };
    }
    const worked = (existing.files || []).length > 0 || (existing.commands || 0) > 0;
    // Save gate: if Claude changed things this turn but saved nothing to Cortex, ask once before it stops.
    if (settings.agents.saveGate !== false && worked && !existing.saved && !existing.gateUsed && !input.stop_hook_active) {
      sessions.upsert(vault, id, { gateUsed: true, step: 'Saving what it learned to Cortex…' }, { kind: 'status', text: 'Save gate: asked Claude to record what it learned' });
      const p = existing.project;
      return { decision: 'block', reason: `Before you finish (Cortex save gate): you changed things in this turn but saved nothing to Cortex. Call memory_write${p ? ` with project "${p}"` : ''} to record what you learned that future sessions need (decisions, how things work, gotchas, what is left to do), updating an existing note if one covers it. If genuinely nothing is worth keeping, call activity_log with a one-line summary instead. Then give your final answer.` };
    }
    // the real end of the turn: write the journal entry (launched runs are journaled by the runner instead)
    if (!launched) {
      try {
        require('./journal').session(vault, existing.project, { agent: 'claude-code', title: existing.turnPrompt || existing.title, outcome: input.last_assistant_message, status: 'done', files: existing.files || [], commands: existing.commands || 0, savedMemory: !!existing.saved, source: where ? `in ${where}` : '' });
      } catch { /* never break Claude */ }
    }
    sessions.upsert(vault, id, { status: 'waiting', step: 'Finished. Waiting for your next instruction', result: clip(input.last_assistant_message || '', 4000), ...(launched ? {} : { files: [], commands: 0 }) }, { kind: 'status', text: '✓ Finished turn' });
    return null;
  }
  if (ev === 'SessionEnd') {
    if (existing) sessions.upsert(vault, id, { status: 'done', step: 'Session ended' }, { kind: 'status', text: `Session ended${input.reason ? ` (${input.reason})` : ''}` });
    return null;
  }
  return null;
}

module.exports = { install, uninstall, repair, status, runHook, describeTool, hookCommand, EVENTS, SAVE_TOOLS, isCortexSave, mentionedProject };
