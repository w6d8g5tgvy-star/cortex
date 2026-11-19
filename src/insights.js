'use strict';
// Knowledge health, memory gardener and the daily briefing. All computed from what's in the vault.
const fs = require('fs');
const path = require('path');
const sessions = require('./sessions');

const DAY = 864e5;
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };

/** Per-project health: is knowledge being recorded and used? */
function health(store) {
  const now = Date.now();
  const out = [];
  for (const p of store.list('project').filter((r) => r.meta.status !== 'archived')) {
    const notes = store.list('note', { project: p.slug });
    const journal = notes.find((n) => n.meta.agent_journal);
    const mems = notes.filter((n) => !n.meta.agent_journal);
    const body = journal ? String(journal.body) : '';
    const entries = (body.match(/^### /gm) || []).length;
    const unsaved = (body.match(/\*\*Saved to memory:\*\* no/g) || []).length;
    const saved = (body.match(/\*\*Saved to memory:\*\* yes/g) || []).length;
    const lastJournal = journal ? journal.updated : null;
    const lastMemory = mems.reduce((m, n) => (n.updated > m ? n.updated : m), '');
    const stuck = store.list('task', { project: p.slug, status: 'doing' }).filter((t) => now - new Date(t.updated).getTime() > 7 * DAY);
    const issues = [];
    if (!p.meta.instructions) issues.push('No agent instructions yet: agents get no project-specific guidance.');
    if (!p.meta.folder) issues.push('No code folder linked: Claude Code sessions in this project\'s folder won\'t be filed under it.');
    if (entries && !mems.length) issues.push('Agents have worked here but no project memories exist yet.');
    if (unsaved > saved && unsaved >= 2) issues.push(`${unsaved} agent sessions finished without saving anything to memory.`);
    if (stuck.length) issues.push(`${stuck.length} task${stuck.length > 1 ? 's' : ''} stuck "in progress" for over a week.`);
    let score = 100 - issues.length * 18;
    if (!entries) score -= 5;
    out.push({ project: p.slug, title: p.title, color: p.meta.color, score: Math.max(5, score), memories: mems.length, sessions: entries, savedSessions: saved, unsavedSessions: unsaved, lastAgentWork: lastJournal, lastMemory: lastMemory || null, issues, journal: journal ? journal.id : null });
  }
  return out;
}

/** Find memory housekeeping work. Suggestions only: nothing is changed automatically. */
function garden(store) {
  const notes = store.list('note').filter((n) => !n.meta.agent_journal);
  const dupes = [];
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i]; const ta = tokens(a.title); const ba = tokens(a.body).slice(0, 400);
    for (let j = i + 1; j < notes.length; j++) {
      const b = notes[j];
      if ((a.meta.project || '') !== (b.meta.project || '') && a.meta.project && b.meta.project) continue;
      const tsim = jaccard(ta, tokens(b.title));
      const bsim = jaccard(ba, tokens(b.body).slice(0, 400));
      if (a.title.toLowerCase() === b.title.toLowerCase() || tsim >= 0.75 || (tsim >= 0.4 && bsim >= 0.55) || bsim >= 0.8) dupes.push({ a: a.id, b: b.id, titles: [a.title, b.title], similarity: Math.round(Math.max(tsim, bsim) * 100) });
    }
  }
  const linked = new Set();
  for (const n of store.items.values()) for (const l of n.links || []) linked.add(l);
  const orphans = notes.filter((n) => !(n.links || []).length && !linked.has(n.id) && !n.meta.pinned).map((n) => ({ id: n.id, title: n.title }));
  const stale = notes.filter((n) => Date.now() - new Date(n.updated).getTime() > 120 * DAY).map((n) => ({ id: n.id, title: n.title, updated: n.updated }));
  const empty = notes.filter((n) => String(n.body).replace(/^#.*$/m, '').trim().length < 30).map((n) => ({ id: n.id, title: n.title }));
  return { duplicates: dupes.slice(0, 40), orphans: orphans.slice(0, 60), stale: stale.slice(0, 60), empty: empty.slice(0, 40) };
}

const GARDEN_PROMPT = `Tend the user's Cortex memory vault (a "gardening" pass). Work only through the cortex MCP tools.
1. Read the gardener report below, then use memory_list / memory_get to inspect the notes it mentions.
2. Do NOT delete or overwrite anything. Instead write ONE note with memory_write, titled "Gardener report <today's date>" (no project, type "plan"), containing proposals:
   - duplicate notes that should be merged (and a merged draft),
   - notes that contradict each other (quote both),
   - project memories that are really general and could become system memories (and vice versa),
   - empty or stale notes worth updating or archiving.
3. Finish with activity_log summarising the proposals. The user will decide what to apply.`;

/** What happened since `sinceMs` and what needs the user. */
function briefing(store, sinceMs = Date.now() - DAY) {
  const since = new Date(sinceMs).toISOString();
  const act = store.activity.filter((a) => a.ts >= since);
  const byAgent = {};
  for (const a of act) if (!/^you/.test(a.agent) && a.agent !== 'cortex' && a.action !== 'connect') (byAgent[a.agent] = byAgent[a.agent] || []).push(a);
  const done = store.list('task').filter((t) => t.meta.status === 'done' && (t.meta.completed || t.updated) >= since);
  const newMems = store.list('note').filter((n) => !n.meta.agent_journal && n.created >= since);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  const open = store.list('task', { open: true });
  const overdue = open.filter((t) => t.meta.due && t.meta.due < today);
  const dueSoon = open.filter((t) => t.meta.due && t.meta.due >= today && t.meta.due <= soon);
  const blocked = open.filter((t) => t.meta.status === 'blocked');
  const live = sessions.list(store.vault);
  for (const s of live) if (s.updated >= since && s.title) (byAgent[s.agent] = byAgent[s.agent] || []).push({ summary: `${s.title}${s.status === 'working' ? ' (working now)' : ''}` });
  const needsYou = live.filter((s) => s.status === 'needs-you' && !s.archived);
  const mindDone = store.list('mind').filter((m) => m.meta.status === 'done' && (m.meta.processed || m.updated) >= since);
  const mindQueued = store.list('mind').filter((m) => m.meta.status === 'queued');
  const lines = [`# Daily briefing · ${today}`, ''];
  const agentNames = Object.keys(byAgent);
  lines.push(`**Since ${new Date(sinceMs).toLocaleString()}:** ${agentNames.length} agent${agentNames.length === 1 ? '' : 's'} active, ${act.length} recorded actions, ${done.length} task${done.length === 1 ? '' : 's'} completed, ${newMems.length} new memor${newMems.length === 1 ? 'y' : 'ies'}.`, '');
  if (needsYou.length || overdue.length || blocked.length) {
    lines.push('## Needs you');
    for (const s of needsYou) lines.push(`- ${s.agent}: ${s.step || s.title}`);
    for (const t of overdue) lines.push(`- Overdue: ${t.title} (due ${t.meta.due})`);
    for (const t of blocked) lines.push(`- Blocked: ${t.title}`);
    lines.push('');
  }
  if (agentNames.length) {
    lines.push('## What your agents did');
    for (const a of agentNames) {
      const items = byAgent[a];
      lines.push(`- **${a}** (${items.length}): ${items.slice(-4).map((x) => x.summary).join('; ')}`);
    }
    lines.push('');
  }
  if (done.length) lines.push('## Completed', ...done.slice(0, 12).map((t) => `- ${t.title}${t.meta.project ? ` · ${t.meta.project}` : ''}`), '');
  if (newMems.length) lines.push('## New memories', ...newMems.slice(0, 12).map((n) => `- [[${n.title}]]${n.meta.project ? ` · ${n.meta.project}` : ' · system'}`), '');
  if (dueSoon.length) lines.push('## Due in the next 3 days', ...dueSoon.map((t) => `- ${t.title} (${t.meta.due})`), '');
  if (mindDone.length || mindQueued.length) lines.push('## Mind', `- ${mindDone.length} processed, ${mindQueued.length} waiting`, '');
  return { markdown: lines.join('\n'), counts: { actions: act.length, agents: agentNames.length, done: done.length, memories: newMems.length, needsYou: needsYou.length, overdue: overdue.length, dueSoon: dueSoon.length, blocked: blocked.length } };
}

module.exports = { health, garden, briefing, GARDEN_PROMPT };
