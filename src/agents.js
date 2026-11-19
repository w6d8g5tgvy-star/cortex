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
function createCommand(vault, { text, target, project, from }) {
  text = String(text || '').trim();
  if (!text) throw new Error('The instruction is empty');
  fs.mkdirSync(cmdDir(vault), { recursive: true });
  const cmd = { id: 'cmd-' + crypto.randomBytes(5).toString('hex'), ts: now(), target: String(target || 'any').trim() || 'any', text: text.slice(0, 8000), project: project || undefined, from: from || 'you', status: 'pending' };
  writeAtomic(path.join(cmdDir(vault), cmd.id + '.json'), cmd);
  return cmd;
}

function listCommands(vault, { limit = 100 } = {}) {
  let files = [];
  try { files = fs.readdirSync(cmdDir(vault)).filter((f) => /^cmd-[a-f0-9]+\.json$/.test(f)); } catch { return []; }
  return files.map((f) => readJson(path.join(cmdDir(vault), f))).filter(Boolean).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}

const matches = (target, agent) => target === 'any' || String(target).toLowerCase() === String(agent || '').toLowerCase();

/** Claim pending commands for this agent (each command goes to exactly one agent). */
function claimCommands(vault, agent, max = 5) {
  const out = [];
  for (const c of listCommands(vault).reverse()) {
    if (out.length >= max) break;
    if (c.status !== 'pending' || !matches(c.target, agent)) continue;
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

const commandView = (c) => ({ id: c.id, instruction: c.text, project: c.project, from: c.from, sent: c.ts });

// ---------------- launcher ----------------
const which = (bin) => new Promise((res) => execFile(process.platform === 'win32' ? 'where' : 'which', [bin], (e, out) => res(e ? null : String(out).split(/\r?\n/)[0].trim() || null)));

const TOOLS = {
  claude: { label: 'Claude Code', agent: 'claude-code', bin: () => process.env.CORTEX_CLAUDE_BIN || 'claude' },
  codex: { label: 'Codex', agent: 'codex', bin: () => process.env.CORTEX_CODEX_BIN || 'codex' },
};

class AgentRunner {
  constructor(store) { this.store = store; this.vault = store.vault; this.procs = new Map(); }

  async available() {
    const out = {};
    for (const [k, t] of Object.entries(TOOLS)) {
      const b = t.bin();
      out[k] = { label: t.label, installed: path.isAbsolute(b) ? fs.existsSync(b) : !!(await which(b)) };
    }
    return out;
  }

  running() { return [...this.procs.keys()]; }

  launch({ tool = 'claude', prompt, cwd, permission = 'acceptEdits', maxMinutes = 120, project, task, resume, continues, from }) {
    const t = TOOLS[tool];
    if (!t) throw new Error(`Unknown agent tool "${tool}"`);
    prompt = String(prompt || '').trim();
    if (!prompt && !task) throw new Error('Tell the agent what to do');
    if (resume && tool !== 'claude') throw new Error('Only Claude Code runs can be continued');
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Folder not found: ${cwd}`);
    if (this.procs.size >= 4) throw new Error('Already running 4 agents. Stop one first.');
    const id = 'run-' + crypto.randomBytes(5).toString('hex');
    const hooks = tool === 'claude' && claudeHooks.status().installed;
    // Every launched agent gets the Cortex brief: standing + project instructions, open tasks, memories, rules.
    const b = resume ? { text: prompt, project, task } : brief.buildBrief(this.store, { project, task, assignment: prompt, runId: id });
    const taskRec = b.task ? this.store.get(b.task) : null;
    const title = (prompt || (taskRec && taskRec.title) || '').replace(/\s+/g, ' ').slice(0, 140);
    let args;
    if (tool === 'claude') {
      // Documented pattern: piped stdin is the material, the -p argument is the instruction (fixed text, never user input).
      args = ['-p', 'Follow the Cortex brief and assignment provided on stdin.', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__cortex__*'];
      if (resume) args.push('--resume', String(resume).replace(/[^\w-]/g, ''));
      if (['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(permission)) args.push('--permission-mode', permission);
    } else {
      args = ['exec', '--skip-git-repo-check'];
      if (permission === 'acceptEdits') args.push('--full-auto');
      if (permission === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
      args.push('-');
    }
    sessions.upsert(this.vault, id, { agent: t.agent, title, status: 'working', step: `Starting ${t.label}…`, cwd, workspace: path.basename(cwd), launched: true, tool, permission, project: b.project, task: b.task, prompt: prompt.slice(0, 4000), continues, from }, { kind: 'prompt', text: `▶ ${(prompt || title).slice(0, 400)}` });
    if (taskRec && taskRec.meta.status !== 'done') this.store.update(taskRec.id, { status: 'doing', assignee: t.agent });
    const win = process.platform === 'win32';
    // The prompt goes through stdin, never through a shell command line.
    const spawnArgs = win ? args.map((a) => (/[\s*]/.test(a) ? `"${a}"` : a)) : args; // cmd shell needs quoting; args here never contain user text
    const child = spawn(win ? `"${t.bin()}"` : t.bin(), spawnArgs, { cwd, env: { ...process.env, CORTEX_RUN_ID: id }, shell: win, detached: !win, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rec = { child, id, tool, stderr: [], ended: false, stopped: false, project: b.project, task: b.task, prompt: prompt || title, agent: t.agent };
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
    if (rec.tool !== 'claude') {
      sessions.upsert(this.vault, rec.id, { step: line.slice(0, 200) }, { kind: 'step', text: line.slice(0, 500) });
      return;
    }
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      sessions.upsert(this.vault, rec.id, { claude_session: ev.session_id, model: ev.model }, { kind: 'status', text: `Started${ev.model ? ` (${ev.model})` : ''}` });
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
    }
  }

  finish(rec, code, error) {
    if (rec.ended) return;
    rec.ended = true;
    this.procs.delete(rec.id);
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
      sessions.upsert(this.vault, rec.id, { status: 'done', step: 'Finished' }, { kind: 'status', text: '✓ Finished' });
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
  const d = path.resolve(dir).toLowerCase();
  return (allowed || []).some((a) => { const r = path.resolve(a).toLowerCase(); return d === r || d.startsWith(r + path.sep); });
}

module.exports = { createCommand, listCommands, claimCommands, completeCommand, deleteCommand, commandView, AgentRunner, folderAllowed, TOOLS };
