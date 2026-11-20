'use strict';
// Builds the context an agent gets when it is sent to work on something in Cortex, and records the
// outcome back into Cortex afterwards (so memory is updated even if the agent forgets to).
const settings = require('./settings');

const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function instructionsFor(store, projectSlug) {
  const g = settings.load(store.vault).agents.instructions || '';
  const p = projectSlug ? store.get('projects/' + projectSlug) : null;
  return { global: String(g).trim(), project: p ? String(p.meta.instructions || '').trim() : '', projectRec: p };
}

/** Markdown brief for an agent. `task` is a task id (optional). */
function buildBrief(store, { project, task, assignment, runId }) {
  const t = task ? store.must(task) : null;
  const slug = project || (t && t.meta.project) || undefined;
  const ins = instructionsFor(store, slug);
  const p = ins.projectRec;
  const lines = ['# Cortex brief', '', 'You are working for the user through Cortex, their project manager and long-term memory. Cortex is your source of truth: build on what is recorded there, and keep it up to date as you work.', ''];
  if (ins.global) lines.push('## The user\'s standing instructions', '', ins.global, '');
  if (p) {
    lines.push(`## Project: ${p.title} (${'projects/' + p.slug})`, '');
    if (p.meta.description) lines.push(p.meta.description, '');
    if (ins.project) lines.push('### Project instructions (follow these)', '', ins.project, '');
    if (p.body && p.body.trim()) lines.push('### Overview', '', clip(p.body, 1500), '');
    const open = store.list('task', { project: p.slug, open: true, limit: 25 });
    if (open.length) lines.push('### Open tasks', '', ...open.map((r) => `- [${r.meta.status}] ${r.title} (${r.id}, ${r.meta.priority || 'medium'})`), '');
    const notes = store.list('note', { project: p.slug, limit: 15 }).filter((r) => !r.meta.agent_journal);
    if (notes.length) lines.push(`### Project memories: notes/${p.slug}/ (apply only to this project; read the ones you need with memory_get)`, '', ...notes.map((r) => `- ${r.title} (${r.id})${r.meta.pinned ? ' [pinned]' : ''}: ${(r.meta.fetcher_lesson && require('./fetcher').lessonPreview(r, 300)) || clip(String(r.body).replace(/^#.*$/m, '').replace(/\s+/g, ' '), 110)}`), '');
    const journal = store.list('note', { project: p.slug }).find((r) => r.meta.agent_journal);
    if (journal) {
      const recent = String(journal.body).split('\n').filter((l) => /^(- \d\d:\d\d|### |\*\*(Asked|Outcome))/.test(l)).slice(-8);
      if (recent.length) lines.push(`### Recent agent work on this project (from ${journal.id})`, '', ...recent.map((l) => clip(l, 180)), '');
    }
    try {
      const exp = require('./experience').briefLines(require('./experience').digest(store, p.slug));
      if (exp.length) lines.push('### Learned from earlier sessions (experience digest)', '', ...exp, '');
    } catch { /* optional */ }
  }
  // system memories (notes/ root, no project) apply to every project
  const sys = store.list('note', { scope: 'system' }).filter((r) => !r.meta.agent_journal);
  const sysPinned = sys.filter((r) => r.meta.pinned === true).slice(0, 8);
  const sysRecent = sys.filter((r) => r.meta.pinned !== true).slice(0, 8);
  if (sysPinned.length || sysRecent.length) lines.push('### System memories: notes/ (apply to every project)', '', ...[...sysPinned, ...sysRecent].map((r) => `- ${r.title} (${r.id})${r.meta.pinned ? ' [pinned]' : ''}: ${(r.meta.fetcher_lesson && require('./fetcher').lessonPreview(r, 300)) || clip(String(r.body).replace(/^#.*$/m, '').replace(/\s+/g, ' '), r.meta.pinned ? 220 : 110)}`), '');
  if (t) {
    lines.push(`## Your task: ${t.title} (${t.id})`, '', `Status: ${t.meta.status} · priority ${t.meta.priority || 'medium'}${t.meta.due ? ` · due ${t.meta.due}` : ''}`, '');
    if (t.body && t.body.trim()) lines.push(clip(t.body, 4000), '');
  }
  try {
    const want = [t && t.title, t && t.body, assignment].filter(Boolean).join('\n');
    const ls = require('./lesson-select');
    const picks = want.trim() ? ls.select(store, { project: slug, text: want, max: 5, minScore: 2 }) : [];
    if (picks.length) lines.push('### Lessons that fit this task (vetted by Fetcher)', '', ...ls.briefLines(picks), '');
  } catch { /* optional */ }
  if (assignment && String(assignment).trim()) lines.push(t ? '## Extra instructions from the user' : '## Your assignment', '', String(assignment).trim(), '');
  lines.push('## How to work with Cortex',
    '- This brief already contains what `cortex_start` and `project_brief` return: do not call them again. Read a listed memory in full with `memory_get` only when you need it.',
    '- Use the `cortex` MCP tools if they are available. Search memory (`memory_search`) before assuming anything or asking the user.',
    `- Report progress with \`live_update\` at each major step${runId ? '' : ''}; follow any messages_from_user or commands_from_user it returns.`,
    t ? `- Keep the task current: \`task_update\` id "${t.id}" with status doing/blocked/done and short progress notes.` : '- Create or update tasks with `task_create` / `task_update` for work that will take more than one step.',
    slug ? `- Save what you learn about this project with \`memory_write\` and project "${slug}" (stored in notes/${slug}/). Save things that apply to every project (the user's preferences, general how-tos) WITHOUT a project, as system memories. Update existing notes instead of duplicating them.` : '- Save anything worth remembering with `memory_write` (add a project when it is specific to one). Update existing notes instead of duplicating them.',
    '- Finish with `activity_log` summarising what you did, then end your reply with a short summary of the outcome.',
    '- If the Cortex tools are not available, still finish with a clear summary: Cortex records it for you.');
  return { text: lines.join('\n'), project: slug, task: t ? t.id : undefined };
}

/** Record a finished run in Cortex: the project's agent log note, the task, and the activity feed. */
function recordOutcome(store, { project, task, agent, prompt, status, result, runId, files, commands, savedMemory }) {
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  require('./journal').session(store.vault, project, { agent, title: prompt, outcome: result, status, files, commands, savedMemory, source: 'started from Cortex' });
  store.scan(false);
  if (task && store.get(task)) {
    store.update(task, { append: `**${when} · ${agent} (${status}):** ${clip(String(result || '').replace(/\s+/g, ' '), 600) || 'no summary'}` });
  }
  store.log({ agent, action: status === 'done' ? 'run.done' : 'run.failed', summary: `${status === 'done' ? 'Finished' : 'Failed'}: ${clip(prompt, 120)}`, project, ref: task || runId });
}

module.exports = { buildBrief, recordOutcome, instructionsFor };
