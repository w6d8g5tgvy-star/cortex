'use strict';
// Unified AI conversations (2.3, checklist #21). One chat that can switch between the AI tools this computer can
// really run (Claude Code and Codex, through their official command-line programs) while keeping the same project
// context: the Cortex brief (instructions, memories, open tasks), the conversation so far, and attachments.
//
// Honest by design: only installed, supported tools are offered. ChatGPT, Gemini and other apps are not driven from
// here (there is no supported way to do that); they join Cortex as agents over MCP instead.
// Continuation: a Claude Code chat continues its own session (--resume) while the model stays the same; any switch
// (other model or tool) starts a fresh session that gets the brief plus the transcript, so nothing is lost.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = (vault) => path.join(vault, '.cortex', 'conversations');
const now = () => new Date().toISOString();
const safeId = (id) => String(id || '').replace(/[^\w-]/g, '').slice(0, 60);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); }

const MAX_TRANSCRIPT = 14000; // characters of earlier conversation carried into a fresh session
const MAX_ATTACH_TEXT = 20000;

function list(vault, { project } = {}) {
  let files = []; try { files = fs.readdirSync(dir(vault)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJson(path.join(dir(vault), f))).filter((c) => c && !c.deleted && (!project || c.project === project))
    .sort((a, b) => (a.updated < b.updated ? 1 : -1))
    .map((c) => ({ id: c.id, title: c.title, project: c.project, updated: c.updated, messages: c.messages.length, last: c.messages.length ? c.messages[c.messages.length - 1].model || c.messages[c.messages.length - 1].tool : null, busy: c.messages.some((m) => m.pending) }));
}
const get = (vault, id) => { const c = readJson(path.join(dir(vault), safeId(id) + '.json')); return c && !c.deleted ? c : null; };
const save = (vault, c) => { c.updated = now(); writeJson(path.join(dir(vault), c.id + '.json'), c); return c; };
function create(vault, { title, project } = {}) {
  const c = { id: 'chat-' + crypto.randomBytes(5).toString('hex'), title: String(title || 'New conversation').slice(0, 120), project: project || null, created: now(), updated: now(), messages: [], sessions: {} };
  return save(vault, c);
}
function remove(vault, id) { const c = get(vault, id); if (!c) return false; c.deleted = now(); save(vault, c); return true; }
function rename(vault, id, title) { const c = get(vault, id); if (!c) throw new Error('Conversation not found'); c.title = String(title || '').slice(0, 120) || c.title; return save(vault, c); }

/** The earlier conversation, newest kept when it's long. */
function transcript(c, { upTo = c.messages.length } = {}) {
  const lines = [];
  for (const m of c.messages.slice(0, upTo)) {
    if (m.pending || m.error) continue;
    const who = m.role === 'user' ? 'User' : `Assistant (${m.model || m.tool || 'AI'})`;
    lines.push(`${who}: ${String(m.text || '').trim()}${(m.attachments || []).length ? `\n[attached: ${m.attachments.map((a) => a.name).join(', ')}]` : ''}`);
  }
  let out = lines.join('\n\n');
  if (out.length > MAX_TRANSCRIPT) out = '[earlier messages shortened]\n…' + out.slice(out.length - MAX_TRANSCRIPT);
  return out;
}

/** Text of attachments that can be read as text; other files are named honestly. */
function attachmentText(vault, atts = []) {
  const parts = [];
  for (const a of atts) {
    const file = path.join(vault, ...String(a.path || '').split('/'));
    if (!a.path || !file.startsWith(path.join(vault, 'attachments')) || !fs.existsSync(file)) { parts.push(`[${a.name}: file not found]`); continue; }
    if (/\.(md|txt|json|csv|js|ts|tsx|jsx|py|lua|luau|html|css|yml|yaml|xml|log|sh|ps1|java|cs|go|rs|cpp|c|h)$/i.test(file)) {
      let t = fs.readFileSync(file, 'utf8'); if (t.length > MAX_ATTACH_TEXT) t = t.slice(0, MAX_ATTACH_TEXT) + '\n[…cut]';
      parts.push(`--- Attached file: ${a.name} ---\n${t}\n--- end of ${a.name} ---`);
    } else parts.push(`[Attached file ${a.name} (${a.path}) can't be shown as text here. If you need it, say so and the user can describe it.]`);
  }
  return parts.join('\n\n');
}

/**
 * How to send the next message: continue the tool's own session, or start fresh with the transcript.
 * Returns { resume, prompt } where prompt is what goes to the agent (for a fresh session the server adds the brief).
 */
function plan(vault, c, { text, tool, model, attachments = [] }) {
  const prev = c.sessions[tool];
  const sameModel = prev && (prev.model || '') === (model || '');
  const resume = tool === 'claude' && prev && prev.session && sameModel ? prev.session : null;
  const att = attachmentText(vault, attachments);
  const ask = `${String(text).trim()}${att ? `\n\n${att}` : ''}`;
  if (resume) return { resume, prompt: ask, fresh: false };
  const earlier = transcript(c, { upTo: c.messages.length });
  const switched = c.messages.some((m) => m.role === 'assistant' && !m.pending && (m.tool !== tool || (m.model || '') !== (model || '')));
  const prompt = `You are chatting with the user inside Cortex. Answer in plain language. Do not change files unless the user clearly asks you to.${earlier ? `\n\nThe conversation so far${switched ? ' (earlier answers may come from a different AI model; continue from them)' : ''}:\n\n${earlier}` : ''}\n\nUser's new message:\n${ask}`;
  return { resume: null, prompt, fresh: true };
}

function addUser(vault, id, { text, attachments = [], by = 'you' }) {
  const c = get(vault, id); if (!c) throw new Error('Conversation not found');
  text = String(text || '').trim(); if (!text) throw new Error('Type a message');
  if (c.messages.some((m) => m.pending)) throw new Error('Wait for the answer to the last message first');
  const m = { id: 'm-' + crypto.randomBytes(4).toString('hex'), role: 'user', text: text.slice(0, 20000), attachments: attachments.slice(0, 10), by, ts: now() };
  c.messages.push(m);
  if (c.messages.filter((x) => x.role === 'user').length === 1 && /^New conversation$/.test(c.title)) c.title = text.replace(/\s+/g, ' ').slice(0, 60);
  save(vault, c); return { conversation: c, message: m };
}
function addPending(vault, id, { tool, model, runId, route }) {
  const c = get(vault, id); const m = { id: 'm-' + crypto.randomBytes(4).toString('hex'), role: 'assistant', tool, model: model || null, requestedModel: model || '', runId, route: route || null, pending: true, text: '', ts: now() };
  c.messages.push(m); save(vault, c); return m;
}
/** The agent finished: fill in the answer and remember its session for continuation. */
function complete(vault, id, msgId, { status, text, model, session, cost }) {
  const c = get(vault, id); if (!c) return null; const m = c.messages.find((x) => x.id === msgId); if (!m) return null;
  m.pending = false; m.text = String(text || '').slice(0, 40000); m.done = now();
  if (model) m.model = model; if (Number.isFinite(cost)) m.cost_usd = cost;
  if (status !== 'done') m.error = true;
  if (status === 'done' && session && m.tool === 'claude') c.sessions.claude = { session, model: m.requestedModel || m.route?.model || '' };
  if (status === 'done' && m.tool === 'codex') c.sessions.codex = { model: m.requestedModel || '' };
  save(vault, c); return m;
}

/** Text for handing the conversation to another agent (Cortex command / agent_send). */
function handoffText(c, note) {
  return `Handoff from a Cortex conversation "${c.title}"${c.project ? ` (project ${c.project})` : ''}.${note ? `\nWhat to do: ${note}` : ''}\n\nConversation:\n${transcript(c)}`.slice(0, 7900);
}

module.exports = { list, get, create, remove, rename, transcript, plan, addUser, addPending, complete, handoffText, attachmentText, MAX_TRANSCRIPT };
