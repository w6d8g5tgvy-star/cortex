'use strict';
// Model Context Protocol server (JSON-RPC 2.0). Transports: stdio + Streamable HTTP (see server.js).
const fs = require('fs');
const crypto = require('crypto');
const { ENUMS } = require('./store');
const sessions = require('./sessions');
const settings = require('./settings');
const screen = require('./screen');
const agents = require('./agents');
const mind = require('./mind');
const brief = require('./brief');
const skills = require('./skills');
const VERSION = require('../package.json').version;
// One-line reminder for cortex_start; the full rules are the server instructions every client gets at connect.
const RULES_SHORT = 'Search (memory_search) before asking; read full notes with memory_get only when needed; save what you learn with memory_write (with project); keep tasks current (task_create/task_update); report steps with live_update; do commands_from_user and answer with command_complete; finish with activity_log.';
// Tools where an agent can say which model it is (MCP has no field for it). Kept to the few tools every agent calls.
const MODEL_TOOLS = new Set(['cortex_start', 'live_update', 'task_create', 'task_update', 'activity_log', 'command_complete', 'lesson_feedback']);
const MODEL_PROP = { type: 'string', description: 'Your model name, e.g. claude-opus-5-5 or gpt-6.2. Say it once per session; Cortex records it on your tasks and work.' };
const clipText = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s || undefined; };

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Cortex is the user's shared project manager and long-term memory (an Obsidian-style Markdown vault).
Use it like this:
1. At the start of a session call cortex_start (optionally with a project) to load active projects, open tasks, pinned/recent memories and recent agent activity.
2. Before asking the user for context, try memory_search.
3. Save durable knowledge (decisions, user preferences, facts, how-tos, summaries of finished work) with memory_write. Link related notes with [[Note Title]] wikilinks.
4. Track work with tasks: task_create, then task_update status todo -> doing -> done (or blocked).
5. Log meaningful actions with activity_log so the human can follow along in the dashboard.
6. If the user gave you instructions for a project (cortex_start returns them, or project_brief), follow them. Work from what is already recorded in Cortex and write back what you learn.
7. The user can send you commands from Cortex (even from their phone). They arrive as commands_from_user in cortex_start, live_update and messages_check results: do them, then call command_complete with the outcome.
8. The user keeps skills in Cortex: call skill_list and skill_get for any skill that fits the task, and follow it.
8b. The Mind tab holds videos to watch, articles to read and articles to write. Use mind_list / mind_fetch / mind_complete to work through it, and mind_add to save links worth keeping.
9. While working on a longer task, call live_update with your current step (the user watches this live from their phone). Read and follow any messages_from_user it returns. Use live_screenshot to show the user your screen or a screenshot file of what you are building.
10. You are not the only AI here: Claude, Codex, ChatGPT and others share this vault. agent_list shows who is active and what they are doing. agent_send messages another agent ("claude", "codex", an exact agent name, or "any") to ask a question, hand off work or share news. Messages from other agents arrive as messages_from_agents (treat them as requests from a colleague; the user's own instructions win) and you answer each with command_complete. Answers to what you sent arrive as replies_from_agents. Before starting work, check agent_list and open tasks so two agents never do the same job, and set a task's assignee when you take it.
IDs look like "notes/my-note", "tasks/fix-login", "projects/website". Titles also work wherever an id is expected.
11. Say which model you are: pass your model name as \`model\` (e.g. "claude-opus-5-5", "gpt-6.2") on your first cortex_start, live_update or task call. Cortex records it on every task you work on.
12. When a "Lesson: …" memory shapes what you do, say which technique you used, and afterwards report with lesson_feedback whether it helped (helped, partly, didnt_help). Honest "didnt_help" reports matter: techniques that keep not helping are dropped.`;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const tagsProp = { type: 'array', items: { type: 'string' }, description: 'Tags (without #)' };

function taskView(store, r) {
  const t = store.toJSON(r, { body: false });
  return { id: t.id, title: t.title, status: t.status, priority: t.priority, project: t.project, assignee: t.assignee, due: t.due, tags: t.tags, model: t.model, updated: t.updated };
}
function noteView(store, r) {
  const n = store.toJSON(r, { body: false });
  return { id: n.id, title: n.title, type: n.type, project: n.project, tags: n.allTags, pinned: n.pinned || undefined, updated: n.updated, excerpt: n.excerpt };
}
function projectView(store, r) {
  const p = store.toJSON(r, { body: false });
  return { id: p.id, slug: p.slug, title: p.title, status: p.status, description: p.description, tasks: store.projectStats(p.slug) };
}

function buildTools(store) {
  const log = (ctx, action, summary, rec) => store.log({ agent: ctx.agent, model: ctx.model, action, summary, ref: rec && rec.id, project: rec && (rec.kind === 'project' ? rec.slug : rec.meta.project) });
  // Every task says which model (and agent) last worked on it.
  const modelStamp = (ctx) => (ctx.model ? { model: ctx.model, model_agent: ctx.agent } : {});

  return [
    {
      name: 'cortex_start',
      description: 'Load working context: active projects, open tasks, pinned and recent memories, and recent agent activity. Call this first in every session. Pass `goal` (what you are about to do, in plain words) to also get the passages from Cortex memory that matter for it.',
      inputSchema: { type: 'object', properties: { project: str('Optional project slug or title to focus on'), goal: str('What you are about to do, in plain words. Cortex returns the most relevant memory passages as `relevant_memories`.') } },
      run: (a, ctx) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        // Knowledge notes only (agent journals are logs, and their one-off details mislead), best 4 with their key passage.
        const relevant = a.goal ? store.search(a.goal, { kind: 'note', limit: 12, ...(project ? { scope: 'project+system', projectScope: project } : {}) })
          .filter((h) => !h.rec.meta.agent_journal).slice(0, 4)
          .map((h) => ({ id: h.rec.id, title: h.rec.title, passage: store.passage(h.rec, a.goal, 650) || h.snippet })) : null;
        const f = project ? { project } : {};
        const ins = brief.instructionsFor(store, project);
        const inbox = agents.claimInbox(store.vault, ctx.agent);
        const replies = agents.takeReplies(store.vault, ctx.agent);
        const others = agents.peers(store, { hours: 6, self: ctx.agent }).filter((p) => !p.you).slice(0, 8);
        // Lean by design: this is loaded at the start of most sessions, so every field costs tokens each time.
        // Full rules arrive with the server instructions at connect; whole notes are one memory_get away.
        const mind = store.list('mind', { status: ['queued', 'fetched'], limit: 10 }).map((r) => ({ id: r.id, section: r.meta.section, title: r.title, url: r.meta.url, status: r.meta.status }));
        const isJournal = (r) => r.meta.agent_journal;
        const lean = (r) => { const v = noteView(store, r); return { id: v.id, title: v.title, type: v.type !== 'memory' ? v.type : undefined, pinned: v.pinned, updated: String(v.updated || '').slice(0, 10), excerpt: clipText(v.excerpt, 120) }; };
        const pnotes = project ? store.list('note', { project, limit: 16 }) : [];
        const snotes = store.list('note', { scope: 'system' });
        return {
          ...(relevant ? { relevant_memories: relevant.length ? relevant : 'Nothing in Cortex memory matches this goal yet.' } : {}),
          cortex_version: VERSION,
          you_are: ctx.agent,
          your_model: ctx.model || 'not reported yet: pass your model name as `model` (e.g. in live_update or task_update) so your tasks show it',
          rules: RULES_SHORT,
          user_instructions: ins.global || undefined,
          project_instructions: ins.project || undefined,
          commands_from_user: inbox.fromUser,
          ...(inbox.fromAgents.length ? { messages_from_agents: inbox.fromAgents } : {}),
          ...(replies.length ? { replies_from_agents: replies } : {}),
          ...(others.length ? { other_agents_active: others.map((p) => ({ agent: p.agent, family: p.family, last_seen: p.last_seen, project: p.project, step: p.step })) } : {}),
          ...(mind.length ? { mind_queue: mind } : {}),
          vault: store.vault,
          // Lean project rows (slug, title, status, open task count); project_list / project_brief give the full view.
          projects: store.list('project', { status: ['active', 'paused'] }).map((r) => { const v = projectView(store, r); const t = v.tasks || {}; return { slug: v.slug, title: v.title, status: v.status !== 'active' ? v.status : undefined, open_tasks: (t.todo || 0) + (t.doing || 0) + (t.blocked || 0) || undefined }; }),
          open_tasks: store.list('task', { ...f, open: true, limit: 30 }).map((r) => { const t = taskView(store, r); return { id: t.id, title: t.title, status: t.status, priority: t.priority !== 'medium' ? t.priority : undefined, project: project ? undefined : t.project, assignee: t.assignee, due: t.due }; }),
          ...(project ? { project_memories: pnotes.filter((r) => !isJournal(r)).slice(0, 15).map(lean) } : {}),
          // With a goal, the relevant passages above already carry the knowledge: list the other memories by title only.
          system_memories: snotes.filter((r) => !isJournal(r)).slice(0, 12).map((r) => (relevant ? { id: r.id, title: r.title } : lean(r))),
          journals: [...pnotes, ...snotes].filter(isJournal).map((r) => r.id),
          memory_scopes: project ? `notes/${project}/ = this project only; notes/ = every project.` : 'No project given: only system memories (notes/) are listed. Pass project for its memories.',
          recent_activity: store.recentActivity({ project, limit: 8 }).map((a) => ({ ts: String(a.ts || '').slice(0, 16), agent: a.agent, action: a.action, summary: clipText(a.summary, 160), ref: a.ref })),
        };
      },
    },
    // ---------------- projects ----------------
    {
      name: 'project_list',
      description: 'List projects with task progress.',
      inputSchema: { type: 'object', properties: { status: str('Filter by status', { enum: ENUMS.project.status }) } },
      run: (a) => store.list('project', { status: a.status }).map((r) => projectView(store, r)),
    },
    {
      name: 'project_create',
      description: 'Create a new project.',
      inputSchema: {
        type: 'object', required: ['title'],
        properties: { title: str('Project name'), description: str('One-line description'), body: str('Markdown overview / brief'), color: str('Hex color, e.g. #4f9cf9'), status: str('Status', { enum: ENUMS.project.status }), tags: tagsProp },
      },
      run: (a, ctx) => { const r = store.create('project', a); log(ctx, 'project.create', `Created project "${r.title}"`, r); return store.toJSON(r); },
    },
    {
      name: 'project_update',
      description: 'Update a project (name, description, status, color, overview).',
      inputSchema: {
        type: 'object', required: ['project'],
        properties: { project: str('Project id, slug or title'), title: str('New name'), description: str('Description'), instructions: str('Standing instructions agents must follow when working on this project'), folder: str('Code folder on this computer for this project'), body: str('Replace the Markdown overview'), append: str('Append Markdown to the overview'), status: str('Status', { enum: ENUMS.project.status }), color: str('Hex color'), tags: tagsProp },
      },
      run: (a, ctx) => {
        const slug = store.resolveProject(a.project);
        const { project, ...patch } = a;
        const r = store.update('projects/' + slug, patch);
        log(ctx, 'project.update', `Updated project "${r.title}"`, r);
        return store.toJSON(r);
      },
    },
    // ---------------- tasks ----------------
    {
      name: 'task_list',
      description: 'List tasks, sorted by status and priority. Defaults to open (not done) tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          project: str('Project slug or title'), status: str('Comma-separated statuses: todo, doing, blocked, done'), assignee: str('Assignee name'), tag: str('Tag'),
          include_done: { type: 'boolean', description: 'Include completed tasks (ignored if status is set)' }, limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
      run: (a) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        return store.list('task', { project, status: a.status, open: !a.status && !a.include_done, assignee: a.assignee, tag: a.tag, limit: a.limit || 50 }).map((r) => taskView(store, r));
      },
    },
    {
      name: 'task_get',
      description: 'Get a task with its full description and links.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('Task id or title') } },
      run: (a) => {
        const r = store.must(a.id);
        const out = { ...store.toJSON(r), backlinks: store.backlinks(r.id).map((b) => b.id) };
        if (r.kind === 'task') { try { const adv = require('./task-fetcher').advice(store, r); out.fetcher = { enabled: adv.enabled, recommend: adv.recommend, reasons: adv.reasons, pending_requests: adv.pending, how: 'See fetcher_advice / fetcher_request with task: "' + r.id + '"' }; } catch { /* optional */ } }
        return out;
      },
    },
    {
      name: 'task_create',
      description: 'Create a task on the board.',
      inputSchema: {
        type: 'object', required: ['title'],
        properties: {
          title: str('Short task title'), project: str('Project slug or title'), description: str('Markdown details, acceptance criteria, links'),
          status: str('Status (default todo)', { enum: ENUMS.task.status }), priority: str('Priority (default medium)', { enum: ENUMS.task.priority }),
          assignee: str('Who owns it (a person or agent name)'), due: str('Due date YYYY-MM-DD'), tags: tagsProp,
        },
      },
      run: (a, ctx) => {
        const { description, ...rest } = a;
        const r = store.create('task', { ...rest, body: description, created_by: ctx.agent, ...modelStamp(ctx) });
        log(ctx, 'task.create', `Created task "${r.title}"`, r);
        return taskView(store, r);
      },
    },
    {
      name: 'task_update',
      description: 'Update a task: change status/priority/assignee, edit details, or append a progress note.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id: str('Task id or title'), title: str('New title'), status: str('Status', { enum: ENUMS.task.status }), priority: str('Priority', { enum: ENUMS.task.priority }),
          project: str('Move to project'), assignee: str('Assignee'), due: str('Due date YYYY-MM-DD'), tags: tagsProp,
          description: str('Replace the description'), append_note: str('Append a timestamped progress note'),
        },
      },
      run: (a, ctx) => {
        const { id, description, append_note, ...rest } = a;
        const patch = { ...rest, ...modelStamp(ctx) };
        if (description !== undefined) patch.body = description;
        if (append_note) patch.append = `**${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${ctx.agent}${ctx.model ? ` (${ctx.model})` : ''}:** ${append_note}`;
        const r = store.update(id, patch);
        const what = a.status ? `→ ${a.status}` : append_note ? 'added a note' : 'edited';
        log(ctx, 'task.update', `Task "${r.title}" ${what}`, r);
        return taskView(store, r);
      },
    },
    // ---------------- memory ----------------
    {
      name: 'memory_write',
      description: 'Save a new memory/note to the vault (Markdown). Use for decisions, preferences, facts, research, plans and work summaries. Use [[Title]] to link other notes.',
      inputSchema: {
        type: 'object', required: ['title', 'content'],
        properties: {
          title: str('Clear, searchable title'), content: str('Markdown content'), type: str('Kind of memory (default memory)', { enum: ENUMS.note.type }),
          project: str('Project slug or title. With a project the memory is stored in that project\'s folder and only applies to it; without one it is a system memory that applies to every project.'), tags: tagsProp, pinned: { type: 'boolean', description: 'Pin so it is always loaded by cortex_start' },
        },
      },
      run: (a, ctx) => {
        const r = store.create('note', { title: a.title, body: a.content, type: a.type || 'memory', project: a.project, tags: a.tags, pinned: a.pinned, agent: ctx.agent });
        log(ctx, 'memory.write', `Saved memory "${r.title}"`, r);
        return { id: r.id, title: r.title, links: r.links, unresolved_links: r.broken };
      },
    },
    {
      name: 'memory_get',
      description: 'Read any item (note, task or project) by id or title, including its links and backlinks.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('Id (e.g. notes/my-note) or title') } },
      run: (a) => {
        const r = store.must(a.id);
        return { ...store.toJSON(r), backlinks: store.backlinks(r.id).map((b) => ({ id: b.id, title: b.title })), unresolved_links: r.broken };
      },
    },
    {
      name: 'memory_update',
      description: 'Update a note: append to it (preferred for logs/journals), replace its content, or change title/tags/type/project/pinned.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id: str('Note id or title'), append: str('Markdown to append'), content: str('Replace the entire content'), title: str('New title'),
          type: str('Type', { enum: ENUMS.note.type }), project: str('Project slug or title'), tags: tagsProp, pinned: { type: 'boolean' },
        },
      },
      run: (a, ctx) => {
        const { id, content, ...rest } = a;
        const patch = { ...rest, updated_by: ctx.agent };
        if (content !== undefined) patch.body = content;
        const r = store.update(id, patch);
        log(ctx, 'memory.update', `Updated "${r.title}"${a.append ? ' (appended)' : ''}`, r);
        return { id: r.id, title: r.title, updated: r.updated };
      },
    },
    {
      name: 'memory_search',
      description: 'Full-text search across notes, tasks and projects. Returns ranked results with snippets.',
      inputSchema: {
        type: 'object', required: ['query'],
        properties: {
          query: str('Search words'), kind: str('Limit to one kind', { enum: ['note', 'task', 'project', 'mind'] }), type: str('Note type filter'),
          project: str('Project slug: searches that project\'s memories plus system memories'), scope: str('all = every project (default when no project is given)', { enum: ['project', 'all'] }), tag: str('Tag'), limit: { type: 'number', description: 'Max results (default 6)' },
        },
      },
      run: async (a) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        const f = project && a.scope !== 'all' ? { scope: 'project+system', projectScope: project } : {};
        // Default 6 (was 10): every result is written into the agent's context; the top hits now carry passages.
        const opts = { kind: a.kind, type: a.type, tag: a.tag, limit: a.limit || 6, ...f };
        const st = settings.load(store.vault).search;
        const hits = st.semantic && fs.existsSync(require('path').join(store.vault, '.cortex', 'embeddings.json')) ? await require('./semantic').hybrid(store, a.query, opts, st.model) : store.search(a.query, opts);
        return hits
          // The top 3 note hits carry the passage that best answers the query, so the answer is usually readable right here.
          .map((h, i) => { const p = i < 3 && h.rec.kind === 'note' ? store.passage(h.rec, a.query, 600) : ''; return { id: h.rec.id, ...(h.rec.kind !== 'note' ? { kind: h.rec.kind } : {}), title: h.rec.title, score: h.score, ...(p ? { passage: p } : { snippet: h.snippet }), updated: String(h.rec.updated || '').slice(0, 10) }; });
      },
    },
    {
      name: 'memory_list',
      description: 'List notes/memories, newest first (pinned first).',
      inputSchema: {
        type: 'object',
        properties: { type: str('Note type filter'), project: str('Project slug (that project\'s memories only)'), scope: str('system = memories that apply to all projects', { enum: ['system'] }), tag: str('Tag'), limit: { type: 'number', description: 'Max results (default 30)' } },
      },
      run: (a) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        return store.list('note', { type: a.type, project, scope: a.scope, tag: a.tag, limit: a.limit || 30 }).map((r) => noteView(store, r));
      },
    },
    {
      name: 'memory_links',
      description: 'Explore the knowledge graph around an item: outgoing links, backlinks and project siblings.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('Id or title') } },
      run: (a) => {
        const r = store.must(a.id);
        const brief = (x) => ({ id: x.id, kind: x.kind, title: x.title });
        return {
          id: r.id, title: r.title,
          links: r.links.map((l) => store.items.get(l)).filter(Boolean).map(brief),
          backlinks: store.backlinks(r.id).map(brief),
          unresolved_links: r.broken,
          same_project: r.meta.project ? [...store.items.values()].filter((x) => x.meta.project === r.meta.project && x.id !== r.id).slice(0, 25).map(brief) : [],
        };
      },
    },
    {
      name: 'memory_delete',
      description: 'Delete a note, task or project (moved to the vault trash folder, recoverable).',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('Id or title') } },
      run: (a, ctx) => { const r = store.remove(a.id); log(ctx, 'delete', `Deleted ${r.kind} "${r.title}"`, r); return { deleted: r.id }; },
    },
    // ---------------- activity ----------------
    {
      name: 'activity_log',
      description: 'Record what you did (shown live on the dashboard). Use after finishing meaningful work.',
      inputSchema: {
        type: 'object', required: ['summary'],
        properties: { summary: str('What happened, in one or two sentences'), action: str('Short verb, e.g. "coded", "researched", "deployed"'), project: str('Project slug'), ref: str('Related item id') },
      },
      run: (a, ctx) => store.log({ agent: ctx.agent, model: ctx.model, action: a.action || 'log', summary: a.summary, project: a.project ? store.resolveProject(a.project) : undefined, ref: a.ref }),
    },
    {
      name: 'activity_list',
      description: 'See recent activity from all agents and the user.',
      inputSchema: { type: 'object', properties: { agent: str('Filter by agent name'), project: str('Project slug'), limit: { type: 'number', description: 'Default 30' } } },
      run: (a) => store.recentActivity({ agent: a.agent, project: a.project, limit: a.limit || 30 }),
    },
    // ---------------- live view (watched from the phone) ----------------
    {
      name: 'live_update',
      description: 'Report what you are doing right now. The user watches this live on the Cortex dashboard / their phone. Call it when you start a task, at each major step, and when you finish or get blocked. Returns any messages the user sent you from their phone: read and follow them.',
      inputSchema: {
        type: 'object',
        properties: {
          title: str('What the overall task is (set once at the start)'), step: str('What you are doing right now, e.g. "Running the test suite"'),
          status: str('Your state', { enum: ['working', 'waiting', 'needs-you', 'done', 'error'] }), progress: { type: 'number', description: 'Optional percent complete 0-100' },
          detail: str('Optional extra detail / output snippet'), project: str('Project slug'),
        },
      },
      run: (a, ctx) => {
        const patch = { agent: ctx.agent, ...(ctx.model ? { model: ctx.model } : {}), title: a.title, step: a.step, status: a.status || 'working', progress: a.progress === undefined ? undefined : Math.max(0, Math.min(100, Number(a.progress))), project: a.project };
        const text = [a.step, a.detail].filter(Boolean).join(' — ') || (a.status ? `Status: ${a.status}` : '');
        sessions.upsert(store.vault, ctx.sessionId, patch, { kind: a.status && a.status !== 'working' ? 'status' : 'step', text });
        const msgs = sessions.takeMessages(store.vault, ctx.sessionId);
        const inbox = agents.claimInbox(store.vault, ctx.agent);
        const replies = agents.takeReplies(store.vault, ctx.agent);
        return {
          ok: true, session: ctx.sessionId, messages_from_user: msgs.map((m) => m.text),
          ...(inbox.fromUser.length ? { commands_from_user: inbox.fromUser } : {}),
          ...(inbox.fromAgents.length ? { messages_from_agents: inbox.fromAgents } : {}),
          ...(replies.length ? { replies_from_agents: replies } : {}),
        };
      },
    },
    {
      name: 'live_screenshot',
      description: 'Show the user an image on their phone/dashboard: either capture the computer screen (capture_screen: true, if the user enabled screen sharing), or share an image file you created (image_path, e.g. a browser screenshot), or raw base64 image data.',
      inputSchema: {
        type: 'object',
        properties: {
          capture_screen: { type: 'boolean', description: 'Capture the whole computer screen' },
          image_path: str('Absolute path to a PNG/JPEG/WebP/GIF file on this computer'),
          image_base64: str('Base64 image data (PNG/JPEG/WebP/GIF)'), caption: str('What the image shows'),
        },
      },
      run: async (a, ctx) => {
        let buf;
        if (a.capture_screen) {
          if (!settings.load(store.vault).screen.enabled) throw new Error('Screen sharing is turned off. The user can enable it in Cortex → Settings → Screen sharing.');
          buf = await screen.capture();
        } else if (a.image_path) {
          if (!ctx.local) throw new Error('image_path is only allowed for agents running on this computer');
          if (!/\.(png|jpe?g|webp|gif)$/i.test(a.image_path)) throw new Error('image_path must be an image file');
          buf = fs.readFileSync(a.image_path);
        } else if (a.image_base64) {
          buf = Buffer.from(String(a.image_base64).replace(/^data:[^,]+,/, ''), 'base64');
        } else throw new Error('Provide capture_screen, image_path or image_base64');
        if (!sessions.get(store.vault, ctx.sessionId)) sessions.upsert(store.vault, ctx.sessionId, { agent: ctx.agent, status: 'working' });
        sessions.setSnapshot(store.vault, ctx.sessionId, buf, a.caption);
        return { ok: true, bytes: buf.length, messages_from_user: sessions.takeMessages(store.vault, ctx.sessionId).map((m) => m.text) };
      },
    },
    {
      name: 'messages_check',
      description: 'Check for messages and commands the user sent you from the Cortex dashboard or their phone, messages other AI agents sent you, and replies to messages you sent.',
      inputSchema: { type: 'object', properties: {} },
      run: (a, ctx) => {
        const inbox = agents.claimInbox(store.vault, ctx.agent);
        const msgs = sessions.get(store.vault, ctx.sessionId) ? sessions.takeMessages(store.vault, ctx.sessionId).map((m) => ({ text: m.text, sent: m.ts })) : [];
        return { messages_from_user: msgs, commands_from_user: inbox.fromUser, messages_from_agents: inbox.fromAgents, replies_from_agents: agents.takeReplies(store.vault, ctx.agent) };
      },
    },
    // ---------------- agent to agent ----------------
    {
      name: 'agent_send',
      description: 'Send a message to another AI agent working with Cortex (for example Codex, Claude Code or ChatGPT): ask a question, hand off work, or share something they need to know. It reaches them the next time they call cortex_start, live_update or messages_check; their answer comes back to you as replies_from_agents. Use agent_list to see who is active.',
      inputSchema: {
        type: 'object', required: ['to', 'message'],
        properties: {
          to: str('Who should get it: "claude" (any Claude app), "codex" / "openai" (Codex or ChatGPT), an exact agent name from agent_list, or "any"'),
          message: str('What you need or want them to know. Be self-contained: they do not see your conversation.'),
          kind: str('request (default): they should do something and reply · handoff: they take over a task · info: just so they know', { enum: ['request', 'handoff', 'info'] }),
          project: str('Project slug or title it is about'),
          task: str('Task id or title it is about. A handoff also assigns the task to them.'),
          reply_to: str('Id of a message you are answering, if any'),
        },
      },
      run: (a, ctx) => {
        const to = String(a.to || '').trim();
        if (!to) throw new Error('Say who the message is for (to)');
        if (to.toLowerCase() === String(ctx.agent).toLowerCase()) throw new Error('That is you. Use agent_list to find another agent.');
        const t = a.task ? store.must(a.task) : null;
        const project = a.project ? store.resolveProject(a.project) : t ? t.meta.project : undefined;
        const kind = a.kind || 'request';
        const c = agents.createCommand(store.vault, { text: a.message, target: to, project, from: ctx.agent, kind, task: t ? t.id : undefined, replyTo: a.reply_to });
        if (t) {
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          store.update(t.id, { ...(kind === 'handoff' ? { assignee: to } : {}), append: `**${stamp} · ${ctx.agent} → ${to} (${kind}, ${c.id}):** ${String(a.message).slice(0, 500)}` });
        }
        store.log({ agent: ctx.agent, action: 'agent.message', summary: `${kind === 'handoff' ? 'Handed off to' : 'Messaged'} ${to}: ${String(a.message).slice(0, 120)}`, project, ref: t ? t.id : undefined });
        return { ok: true, id: c.id, to, kind, delivered: 'when they next check in', next: 'Their answer will come back as replies_from_agents in live_update, messages_check or cortex_start. agent_list shows what you sent.' };
      },
    },
    {
      name: 'ai_usage',
      description: 'How many tokens Claude Code and Codex used on this computer in the last 5 hours, day and week, the Codex plan quota (percent used and reset time), and any recent "usage limit" hits. Check it before a long job: if you are close to a limit, hand the work to another agent with agent_send.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const r = require('./usage').report(sessions.list(store.vault));
        const tool = (x) => ({ found: x.found, tokens_5h: x.windows.h5.total, tokens_24h: x.windows.d1.total, tokens_7d: x.windows.d7.total, last_activity: x.lastActivity, quota: x.limits || undefined });
        return { claude_code: tool(r.claude), codex: tool(r.codex), limit_hits_24h: r.notices, note: 'Counts come from the tools\' own logs on this computer. Claude does not log its quota percentage, so only limit hits are shown for Claude.' };
      },
    },
    {
      name: 'agent_list',
      description: 'See which AI agents have been working with Cortex recently (newest first), what each is doing now, and the state of the messages you sent them.',
      inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Look back this many hours (default 72)' } } },
      run: (a, ctx) => ({ you_are: ctx.agent, agents: agents.peers(store, { hours: Number(a.hours) || 72, self: ctx.agent }), messages_you_sent: agents.sentBy(store.vault, ctx.agent) }),
    },
    {
      name: 'command_complete',
      description: 'Report the outcome of a command the user sent you (commands_from_user) or answer a message from another agent (messages_from_agents). Agents get your answer back automatically.',
      inputSchema: { type: 'object', required: ['id', 'result'], properties: { id: str('Command id, e.g. cmd-ab12cd34ef'), result: str('What you did / the answer'), failed: { type: 'boolean', description: 'true if you could not do it' } } },
      run: (a, ctx) => {
        const c = agents.completeCommand(store.vault, a.id, { result: a.result, failed: a.failed }, ctx.agent);
        if (c.task && store.get(c.task)) {
          try { store.update(c.task, { append: `**${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${ctx.agent} → ${c.from} (reply to ${c.id}${a.failed ? ', could not do it' : ''}):** ${String(a.result).slice(0, 500)}` }); } catch { /* the task may have been deleted */ }
        }
        store.log({ agent: ctx.agent, model: ctx.model, action: a.failed ? 'command.failed' : 'command.done', summary: `${a.failed ? 'Could not do' : 'Did'}: ${c.text.slice(0, 120)}`, project: c.project });
        return { ok: true, id: c.id, status: c.status };
      },
    },
    {
      name: 'project_brief',
      description: 'Get the full working brief for a project or task: the user\'s standing instructions, project instructions, overview, open tasks, memories and the rules for working in Cortex. Call this before starting work on a project.',
      inputSchema: { type: 'object', properties: { project: str('Project slug or title'), task: str('Task id or title') } },
      run: (a) => brief.buildBrief(store, { project: a.project ? store.resolveProject(a.project) : undefined, task: a.task ? store.must(a.task).id : undefined }).text,
    },
    {
      name: 'agent_check',
      description: 'Check, on the computer running Cortex, whether Claude Code (or Codex) is installed where Cortex can start it, which version, and whether it is signed in. Makes one tiny request to test sign-in.',
      inputSchema: { type: 'object', properties: { tool: str('claude or codex (default claude)', { enum: ['claude', 'codex'] }) } },
      run: async (a, ctx) => {
        const { AgentRunner } = require('./agents');
        const r = await new AgentRunner(store).check(a.tool || 'claude');
        store.log({ agent: ctx.agent, action: 'agent.check', summary: `${r.label}: ${r.found ? 'found' : 'not found'}${r.signedIn === true ? ', signed in' : r.signedIn === false ? ', not signed in' : ''}` });
        return r;
      },
    },
    {
      name: 'phone_link',
      description: 'Get the link that opens the Cortex dashboard on the user\'s phone (already paired: opening it pairs the phone). Use it when the user asks how to open Cortex on their phone. Give the link only to the user; never save it in memory, tasks or files, because it contains their pairing key.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        if (!phoneLinkProvider) return 'Phone links are only available from the running Cortex app.';
        const r = await phoneLinkProvider();
        if (!r.links.length) return 'No phone link is available right now: this computer has no network address and no public link is running. Turn on the public link in Cortex → Settings → Connect AI apps, or connect the computer to Wi-Fi or Tailscale.';
        const lines = r.links.map((l) => `- ${l.label}: ${l.url}`);
        return ['Open one of these on the phone (the first works anywhere):', ...lines, '',
          r.remoteEnabled ? '' : 'Note: phone access over Wi-Fi/Tailscale is turned off in Settings → Phone access, so only the public link works until it is turned on.',
          r.links[0].kind === 'public' ? 'The public link changes when Cortex restarts; Tailscale gives a permanent one.' : '',
          'Do not save these links in Cortex memory: they contain the pairing key.'].filter(Boolean).join('\n');
      },
    },
    {
      name: 'agent_launch',
      description: 'Ask to start Claude Code or Codex on one of the user\'s computers (this computer, or a paired one by name) to do a piece of work. The request waits for the user\'s approval in Cortex (Agents page or phone) unless they turned on auto-approve. Use it to hand off work that needs a real coding agent in a project folder. Check progress with agent_jobs.',
      inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: str('What the agent should do, in plain words'), project: str('Project slug or title (its folder is used on that computer)'), task: str('Task id or title it is for (optional)'), computer: str('Which computer: "this computer" (default) or a paired computer\'s name'), tool: str('claude (default) or codex', { enum: ['claude', 'codex'] }), model: str('Model (optional), e.g. claude-sonnet-5-5') } },
      run: (a, ctx) => {
        const jobs = require('./jobs');
        const conf = settings.load(store.vault).agents;
        if (!conf.enabled) throw new Error('Starting agents is turned off on the main computer (Settings → Agent control).');
        let device = 'local'; let deviceName = 'This computer';
        const want = String(a.computer || '').trim().toLowerCase();
        if (want && !['this computer', 'local', 'this', 'here'].includes(want)) {
          const c = require('./devices').list(store.vault).filter((d) => d.kind === 'computer');
          const d = c.find((x) => x.name.toLowerCase() === want) || c.find((x) => x.name.toLowerCase().includes(want));
          if (!d) throw new Error(`No paired computer called "${a.computer}". Paired computers: ${c.map((x) => x.name).join(', ') || 'none'}.`);
          device = d.id; deviceName = d.name;
        }
        const task = a.task ? store.must(a.task).id : undefined;
        const j = jobs.create(store.vault, { device, deviceName, tool: a.tool || 'claude', model: a.model, prompt: a.prompt, project: a.project ? store.resolveProject(a.project) : undefined, task, from: ctx.agent, needsApproval: conf.autoApproveAgentLaunch !== true });
        store.log({ agent: ctx.agent, action: 'agent.launch.request', summary: `Asked to run ${j.tool === 'codex' ? 'Codex' : 'Claude Code'} on ${deviceName}: ${String(j.prompt).slice(0, 120)}`, project: j.project, ref: j.id });
        return { id: j.id, status: j.status, computer: deviceName, message: j.status === 'needs-approval' ? 'Sent to the user for approval (Cortex → Agents, or their phone). Check with agent_jobs.' : 'Queued.' };
      },
    },
    {
      name: 'agent_jobs',
      description: 'Status of agent jobs started through Cortex (on this or paired computers): waiting for approval, queued, running, done, failed; with the latest step and result.',
      inputSchema: { type: 'object', properties: { id: str('Job id (optional)') } },
      run: (a) => {
        const jobs = require('./jobs');
        const view = ({ key, ...j }) => ({ id: j.id, status: j.status, computer: j.deviceName, tool: j.tool, prompt: String(j.prompt || '').slice(0, 200), step: j.step, result: j.result ? String(j.result).slice(0, 1500) : undefined, created: j.created });
        if (a.id) { const j = jobs.get(store.vault, a.id); if (!j) throw new Error('Unknown job id'); return view(j); }
        return jobs.list(store.vault, { limit: 10 }).map(view);
      },
    },
    {
      name: 'smartsave_checkpoints',
      description: 'SmartSave: the latest saved checkpoints of a project (files saved automatically from its folder, with recovery context: task, last step, files touched, blockers, git branch) and where each is backed up. Use it to continue unfinished work, for example after a crash, a limit, or on another computer (ask the user to restore it, or restore with the Cortex dashboard).',
      inputSchema: { type: 'object', required: ['project'], properties: { project: str('Project slug or title'), limit: { type: 'number', description: 'How many (default 5)' } } },
      run: (a) => {
        const { SmartSave } = require('./smartsave');
        const path = require('path');
        const slug = store.resolveProject(a.project);
        const ss = new SmartSave({ home: path.join(store.vault, '.cortex', 'smartsave'), store, config: () => settings.load(store.vault).smartsave });
        const st = ss.status().projects[slug];
        const list = ss.snapshots(slug, { limit: Math.min(20, Number(a.limit) || 5) });
        let latest = null; if (list[0] && !list[0].corrupt) { const m = ss.repo.getSnapshot(slug, list[0].id); latest = { id: m.id, time: m.time, device: m.device, reason: m.reason, files: m.files.length, git: m.git, context: m.context, deleted: m.deleted.slice(0, 20) }; }
        return { project: slug, enabled: !!(st && st.enabled), protection: st ? st.protection : 'off', lastProtected: st ? st.lastProtected : null, latest, checkpoints: list.map((x) => ({ id: x.id, time: x.time, reason: x.reason, device: x.device, files: x.files })) };
      },
    },
    {
      name: 'smartsave_save',
      description: 'SmartSave: save a checkpoint of a project folder right now (before a risky change, or when you are about to run out of context or tokens). Free: no AI is used. Only works for projects the user turned SmartSave on for.',
      inputSchema: { type: 'object', required: ['project'], properties: { project: str('Project slug or title') } },
      run: (a) => {
        const { SmartSave } = require('./smartsave');
        const path = require('path');
        const slug = store.resolveProject(a.project);
        const ss = new SmartSave({ home: path.join(store.vault, '.cortex', 'smartsave'), store, config: () => settings.load(store.vault).smartsave });
        if (!ss.enabledProjects().includes(slug)) throw new Error('SmartSave is not turned on for this project (the user can turn it on in the project).');
        const r = ss.checkpoint(slug, { reason: 'saved by an agent', force: true });
        // the running Cortex uploads it
        try { const fs = require('fs'); const d = path.join(store.vault, '.cortex', 'smartsave', 'triggers'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${Date.now()}-mcp.json`), JSON.stringify({ reason: 'upload', project: slug, urgent: false })); } catch { /* the timer uploads it anyway */ }
        return { saved: r.snapshot, files: r.files, changed: (r.changed || 0) + (r.added || 0), deleted: r.deleted || 0, note: 'Saved locally; Cortex uploads it to the backup targets in the background.' };
      },
    },
    {
      name: 'experience_digest',
      description: 'What earlier agent sessions on a project learned the hard way, worked out from its agent journal for free: files changed most, fail → fix pairs, recurring trouble, and who saves what they learn. Read it before starting work; turn real patterns into memory_write rules.',
      inputSchema: { type: 'object', required: ['project'], properties: { project: str('Project slug or title') } },
      run: (a) => {
        const exp = require('./experience');
        const slug = store.resolveProject(a.project);
        const r = exp.writeDigest(store, slug);
        return exp.markdown(r.digest, store.get('projects/' + slug).title) + `\n\n(Saved as ${r.id}.)`;
      },
    },
    {
      name: 'daily_briefing',
      description: 'Summary of what happened recently (agent work, completed tasks, new memories) and what needs the user (approvals, overdue and blocked tasks).',
      inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Look back this many hours (default 24)' } } },
      run: (a) => require('./insights').briefing(store, Date.now() - (Number(a.hours) || 24) * 3600e3).markdown,
    },
    // ---------------- skills ----------------
    {
      name: 'skill_list',
      description: 'List the user\'s skills (reusable instructions for specific kinds of work). Use skill_get to read one that fits your task.',
      inputSchema: { type: 'object', properties: {} },
      run: () => store.list('skill').map((r) => ({ name: r.slug, title: r.title, description: r.meta.description || '' })),
    },
    {
      name: 'skill_get',
      description: 'Read a skill\'s full instructions and follow them.',
      inputSchema: { type: 'object', required: ['name'], properties: { name: str('Skill name from skill_list') } },
      run: (a) => { const r = store.get('skills/' + String(a.name).replace(/^skills\//, '')) || store.must(a.name); if (r.kind !== 'skill') throw new Error('Not a skill'); return skills.skillMd(r); },
    },
    {
      name: 'skill_save',
      description: 'Create or update a skill in the user\'s library (only when the user asks you to save a skill).',
      inputSchema: { type: 'object', required: ['title', 'description', 'instructions'], properties: { title: str('Skill name'), description: str('When to use it (one or two sentences)'), instructions: str('The skill instructions in Markdown') } },
      run: (a, ctx) => {
        const existing = store.list('skill').find((r) => r.title.toLowerCase() === String(a.title).toLowerCase());
        const r = existing ? store.update(existing.id, { description: a.description, body: a.instructions }) : store.create('skill', { title: a.title, description: a.description, body: a.instructions, author: ctx.agent });
        store.log({ agent: ctx.agent, action: 'skill.save', summary: `${existing ? 'Updated' : 'Created'} skill "${r.title}"`, ref: r.id });
        return { name: r.slug, id: r.id };
      },
    },
    // ---------------- mind ----------------
    {
      name: 'mind_list',
      description: 'List Mind items: videos to watch, articles to read, articles to write. Defaults to items still waiting to be processed.',
      inputSchema: { type: 'object', properties: { section: str('watch, read or write', { enum: ENUMS.mind.section }), status: str('Comma-separated: queued, fetched, processing, done, failed'), all: { type: 'boolean', description: 'Include done items' }, limit: { type: 'number' } } },
      run: (a) => store.list('mind', { section: a.section, status: a.status || (a.all ? undefined : ['queued', 'fetched', 'processing', 'failed']), limit: a.limit || 30 })
        .map((r) => ({ id: r.id, section: r.meta.section, title: r.title, url: r.meta.url, status: r.meta.status, notes: r.meta.notes, has_transcript: r.meta.has_transcript, added: r.created })),
    },
    {
      name: 'fetcher_request',
      description: 'Ask Cortex Fetcher to research a topic on YouTube: it finds videos, a usefulness checker scores how each would help agents do tasks, and worth-it techniques are saved as a "Lesson: <topic>" memory. First decide whether it is worth it: call fetcher_advice with your task (free), and only request when a proven technique would save more than the research costs. Pass your task id as `task`: the request then shows up on that task, and the user approves it there (it is refused if the user turned Fetcher off for the task). Carry on with your work; check fetcher_status and memory_search later.',
      inputSchema: { type: 'object', properties: { topic: str('What to research, in plain words, e.g. "my test runs take forever in a big Node repo"'), why: str('What you were doing and what you hope to improve'), task: str('The task this is for (id or title): the request shows up on that task'), project: str('Project slug (optional)'), max_videos: { type: 'number', description: 'Videos to review with AI (default 5, max 12)' }, depth: str('quick, normal (default) or deep', { enum: ['quick', 'normal', 'deep'] }), usage: str('How much it may spend: low (default for agents), medium or high', { enum: ['low', 'medium', 'high'] }) }, required: ['topic'] },
      run: (a, ctx) => {
        const { Fetcher } = require('./fetcher');
        const f = new Fetcher({ store, runner: null });
        const job = f.create({ topic: a.topic, why: a.why, task: a.task, project: a.project ? store.resolveProject(a.project) : undefined, maxVideos: a.max_videos, depth: a.depth, usage: a.usage || 'low', from: ctx.agent, byAgent: true }, { start: false });
        return { id: job.id, status: job.status, task: job.task, message: job.status === 'needs-approval' ? `Sent to the user for approval${job.task ? ' on the task ' + job.task : ' in Cortex → Fetcher'}. Carry on with your task; the lesson will be in memory if it is approved and worth it.` : 'Queued: Cortex will research it and save a lesson if anything is worth it. Carry on with your task.' };
      },
    },
    {
      name: 'fetcher_advice',
      description: 'Free check (no AI): is a Fetcher research request a good idea for this task? Returns whether Fetcher is turned on for the task, a recommendation with reasons, vetted lessons that already fit, and the task\'s earlier requests. Call it before fetcher_request.',
      inputSchema: { type: 'object', required: ['task'], properties: { task: str('Task id or title') } },
      run: (a) => {
        const tf = require('./task-fetcher');
        const t = store.must(a.task);
        const adv = tf.advice(store, t);
        return { task: t.id, ...adv, requests: tf.requests(store, t.id).slice(0, 8).map((j) => ({ id: j.id, topic: j.topic, status: j.status, lesson: j.lesson ? j.lesson.id : undefined })) };
      },
    },
    {
      name: 'fetcher_status',
      description: 'Status and results of Fetcher research (one id, or the latest requests): videos checked, worth-it count, top scores, and the lesson memory id.',
      inputSchema: { type: 'object', properties: { id: str('Fetcher job id (optional)') } },
      run: (a) => {
        const { Fetcher } = require('./fetcher');
        const f = new Fetcher({ store, runner: null });
        if (a.id) { const j = f.get(a.id); if (!j) throw new Error('Unknown fetcher id'); return f.summary(j); }
        return f.list().slice(0, 8).map((j) => f.summary(j));
      },
    },
    {
      name: 'lesson_feedback',
      description: 'After you used a technique from a "Lesson: …" memory, say whether it helped. Lessons rank proven techniques first and drop ones that keep not helping, so report honestly, including "didnt_help".',
      inputSchema: { type: 'object', properties: { lesson: str('Lesson title or id, e.g. "Lesson: Writing AGENTS.md for Codex"'), technique: str('Technique name as written in the lesson'), result: str('helped, partly, didnt_help or not_applicable', { enum: ['helped', 'partly', 'didnt_help', 'not_applicable'] }), note: str('One sentence: what you did and what happened') }, required: ['lesson', 'technique', 'result'] },
      run: (a, ctx) => require('./fetcher').recordFeedback(store, { lesson: a.lesson, technique: a.technique, result: a.result, note: a.note, agent: ctx.agent, model: ctx.model }),
    },
    {
      name: 'mind_add',
      description: 'Add something to the user\'s Mind: a video link (watch), an article link (read), or an article to write (write: give a title/topic and notes). The section is guessed from the link if omitted.',
      inputSchema: { type: 'object', properties: { url: str('Link to the video or article'), title: str('Title (required for write items)'), section: str('watch, read or write', { enum: ENUMS.mind.section }), notes: str('Why it matters / instructions'), project: str('Project slug'), fetch: { type: 'boolean', description: 'Fetch the transcript / article text right away' } } },
      run: async (a, ctx) => {
        const { rec, duplicate } = mind.add(store, { ...a, added_by: ctx.agent });
        let fetched = null;
        if (a.fetch && rec.meta.section !== 'write') { try { fetched = await mind.fetchItem(store, rec.id); } catch (e) { fetched = { error: e.message }; } }
        if (!duplicate) store.log({ agent: ctx.agent, action: 'mind.add', summary: `Added to Mind (${rec.meta.section}): ${rec.title}`, ref: rec.id });
        return { id: rec.id, section: rec.meta.section, duplicate, ...(fetched ? { fetched: fetched.error ? { error: fetched.error } : { status: fetched.meta.status, title: fetched.title } } : {}) };
      },
    },
    {
      name: 'mind_fetch',
      description: '"Watch" a video or read an article: Cortex downloads the video\'s title, channel, description and transcript (or the article\'s text) into the item. Then read it with memory_get and save your summary with mind_complete.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('Mind item id') } },
      run: async (a, ctx) => {
        const r = await mind.fetchItem(store, a.id);
        store.log({ agent: ctx.agent, action: 'mind.fetch', summary: `Fetched "${r.title}"`, ref: r.id });
        return { id: r.id, title: r.title, status: r.meta.status, has_transcript: r.meta.has_transcript, note: r.meta.fetch_note || undefined, characters: r.body.length, next: 'Read it with memory_get, then call mind_complete with your summary.' };
      },
    },
    {
      name: 'mind_complete',
      description: 'Save your summary of a watched video / read article (also saved as a memory note linked to the item), or your draft for a write item. Marks the item done.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('Mind item id'), summary: str('Markdown summary: key points, takeaways, notable quotes with timestamps'), draft: str('For write items: the article draft in Markdown'), save_memory: { type: 'boolean', description: 'Also store the summary as a memory note (default true)' }, tags: tagsProp } },
      run: (a, ctx) => {
        const out = mind.complete(store, a.id, { ...a, agent: ctx.agent });
        store.log({ agent: ctx.agent, action: 'mind.done', summary: `${out.item.meta.section === 'write' ? 'Wrote' : 'Summarised'} "${out.item.title}"`, ref: out.item.id, project: out.item.meta.project });
        return { id: out.item.id, status: 'done', memory: out.memory ? out.memory.id : undefined };
      },
    },
  ];
}

// The server registers how to build phone links (it knows the port, tunnel and pairing key).
let phoneLinkProvider = null;
function setPhoneLinkProvider(fn) { phoneLinkProvider = fn; }

function createMcp(store) {
  const tools = buildTools(store);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function handleOne(msg, session) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && (msg.result !== undefined || msg.error !== undefined)) return null; // response to us; ignore
      return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
    }
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;
    if (isNotification) return null;
    switch (method) {
      case 'initialize': {
        const ci = params.clientInfo || {};
        session.agent = session.agent || String(ci.name || 'agent').replace(/[^\w.\- ]/g, '').slice(0, 60) || 'agent';
        store.log({ agent: session.agent, action: 'connect', summary: `${session.agent}${ci.version ? ' ' + ci.version : ''} connected via ${session.transport || 'mcp'}` });
        return ok(id, {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cortex', title: 'Cortex', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: MODEL_TOOLS.has(name) ? { ...inputSchema, properties: { ...inputSchema.properties, model: MODEL_PROP } } : inputSchema })) });
      case 'resources/list': return ok(id, { resources: [] });
      case 'resources/templates/list': return ok(id, { resourceTemplates: [] });
      case 'prompts/list': return ok(id, { prompts: [] });
      case 'tools/call': {
        const tool = byName.get(params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        const { model: saidModel, ...args } = params.arguments || {};
        store.scan(false); // pick up anything the dashboard, hooks or other agents wrote since the last tick
        if (!session.id) session.id = 'mcp-' + crypto.randomBytes(6).toString('hex');
        // MCP has no field for the client's model, so agents say it (optional `model` on any tool); remembered per session.
        const m = require('./models').cleanModelName(saidModel);
        if (m && session.model !== m) { session.model = m; if (session.onModel) session.onModel(m); }
        const ctx = { agent: session.agent || 'agent', sessionId: session.id, local: session.local !== false, model: session.model };
        try {
          const out = await tool.run(args, ctx);
          // Compact JSON: indentation is pure token cost for the model reading it.
          const text = typeof out === 'string' ? out : JSON.stringify(out, (k, v) => (v === undefined ? undefined : v));
          return ok(id, { content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          return ok(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default: return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  async function handle(msg, session) {
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => handleOne(m, session)))).filter(Boolean);
      return out.length ? out : null;
    }
    return handleOne(msg, session);
  }

  return { handle, tools };
}

function runStdio(store) {
  const mcp = createMcp(store);
  const session = { transport: 'stdio' };
  let buf = '';
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const res = await mcp.handle(msg, session);
      if (res) write(res);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`[cortex] MCP stdio server ready (vault: ${store.vault})\n`);
}

module.exports = { createMcp, runStdio, INSTRUCTIONS, VERSION, setPhoneLinkProvider };
