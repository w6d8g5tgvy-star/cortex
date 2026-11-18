'use strict';
// Model Context Protocol server (JSON-RPC 2.0). Transports: stdio + Streamable HTTP (see server.js).
const fs = require('fs');
const crypto = require('crypto');
const { ENUMS } = require('./store');
const sessions = require('./sessions');
const settings = require('./settings');
const screen = require('./screen');
const VERSION = require('../package.json').version;

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Cortex is the user's shared project manager and long-term memory (an Obsidian-style Markdown vault).
Use it like this:
1. At the start of a session call cortex_start (optionally with a project) to load active projects, open tasks, pinned/recent memories and recent agent activity.
2. Before asking the user for context, try memory_search.
3. Save durable knowledge (decisions, user preferences, facts, how-tos, summaries of finished work) with memory_write. Link related notes with [[Note Title]] wikilinks.
4. Track work with tasks: task_create, then task_update status todo -> doing -> done (or blocked).
5. Log meaningful actions with activity_log so the human can follow along in the dashboard.
6. While working on a longer task, call live_update with your current step (the user watches this live from their phone). Read and follow any messages_from_user it returns. Use live_screenshot to show the user your screen or a screenshot file of what you are building.
IDs look like "notes/my-note", "tasks/fix-login", "projects/website". Titles also work wherever an id is expected.`;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const tagsProp = { type: 'array', items: { type: 'string' }, description: 'Tags (without #)' };

function taskView(store, r) {
  const t = store.toJSON(r, { body: false });
  return { id: t.id, title: t.title, status: t.status, priority: t.priority, project: t.project, assignee: t.assignee, due: t.due, tags: t.tags, updated: t.updated };
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
  const log = (ctx, action, summary, rec) => store.log({ agent: ctx.agent, action, summary, ref: rec && rec.id, project: rec && (rec.kind === 'project' ? rec.slug : rec.meta.project) });

  return [
    {
      name: 'cortex_start',
      description: 'Load working context: active projects, open tasks, pinned and recent memories, and recent agent activity. Call this first in every session.',
      inputSchema: { type: 'object', properties: { project: str('Optional project slug or title to focus on') } },
      run: (a) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        const f = project ? { project } : {};
        return {
          instructions: INSTRUCTIONS,
          vault: store.vault,
          stats: store.stats(),
          projects: store.list('project', { status: ['active', 'paused'] }).map((r) => projectView(store, r)),
          open_tasks: store.list('task', { ...f, open: true, limit: 40 }).map((r) => taskView(store, r)),
          pinned_memories: store.list('note', f).filter((r) => r.meta.pinned === true).slice(0, 10).map((r) => noteView(store, r)),
          recent_memories: store.list('note', { ...f, limit: 12 }).map((r) => noteView(store, r)),
          recent_activity: store.recentActivity({ project, limit: 15 }),
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
        properties: { project: str('Project id, slug or title'), title: str('New name'), description: str('Description'), body: str('Replace the Markdown overview'), append: str('Append Markdown to the overview'), status: str('Status', { enum: ENUMS.project.status }), color: str('Hex color'), tags: tagsProp },
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
      run: (a) => { const r = store.must(a.id); return { ...store.toJSON(r), backlinks: store.backlinks(r.id).map((b) => b.id) }; },
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
        const r = store.create('task', { ...rest, body: description, created_by: ctx.agent });
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
        const patch = { ...rest };
        if (description !== undefined) patch.body = description;
        if (append_note) patch.append = `**${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${ctx.agent}:** ${append_note}`;
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
          project: str('Project slug or title'), tags: tagsProp, pinned: { type: 'boolean', description: 'Pin so it is always loaded by cortex_start' },
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
          query: str('Search words'), kind: str('Limit to one kind', { enum: ['note', 'task', 'project'] }), type: str('Note type filter'),
          project: str('Project slug'), tag: str('Tag'), limit: { type: 'number', description: 'Max results (default 10)' },
        },
      },
      run: (a) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        return store.search(a.query, { kind: a.kind, type: a.type, project, tag: a.tag, limit: a.limit || 10 })
          .map((h) => ({ id: h.rec.id, kind: h.rec.kind, title: h.rec.title, score: h.score, snippet: h.snippet, updated: h.rec.updated }));
      },
    },
    {
      name: 'memory_list',
      description: 'List notes/memories, newest first (pinned first).',
      inputSchema: {
        type: 'object',
        properties: { type: str('Note type filter'), project: str('Project slug'), tag: str('Tag'), limit: { type: 'number', description: 'Max results (default 30)' } },
      },
      run: (a) => {
        const project = a.project ? store.resolveProject(a.project) : undefined;
        return store.list('note', { type: a.type, project, tag: a.tag, limit: a.limit || 30 }).map((r) => noteView(store, r));
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
      run: (a, ctx) => store.log({ agent: ctx.agent, action: a.action || 'log', summary: a.summary, project: a.project ? store.resolveProject(a.project) : undefined, ref: a.ref }),
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
        const patch = { agent: ctx.agent, title: a.title, step: a.step, status: a.status || 'working', progress: a.progress === undefined ? undefined : Math.max(0, Math.min(100, Number(a.progress))), project: a.project };
        const text = [a.step, a.detail].filter(Boolean).join(' — ') || (a.status ? `Status: ${a.status}` : '');
        sessions.upsert(store.vault, ctx.sessionId, patch, { kind: a.status && a.status !== 'working' ? 'status' : 'step', text });
        const msgs = sessions.takeMessages(store.vault, ctx.sessionId);
        return { ok: true, session: ctx.sessionId, messages_from_user: msgs.map((m) => m.text) };
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
      description: 'Check for messages the user sent you from the Cortex dashboard or their phone.',
      inputSchema: { type: 'object', properties: {} },
      run: (a, ctx) => {
        if (!sessions.get(store.vault, ctx.sessionId)) return { messages_from_user: [] };
        return { messages_from_user: sessions.takeMessages(store.vault, ctx.sessionId).map((m) => ({ text: m.text, sent: m.ts })) };
      },
    },
  ];
}

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
      case 'tools/list': return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'resources/list': return ok(id, { resources: [] });
      case 'resources/templates/list': return ok(id, { resourceTemplates: [] });
      case 'prompts/list': return ok(id, { prompts: [] });
      case 'tools/call': {
        const tool = byName.get(params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        const args = params.arguments || {};
        if (!session.id) session.id = 'mcp-' + crypto.randomBytes(6).toString('hex');
        const ctx = { agent: session.agent || 'agent', sessionId: session.id, local: session.local !== false };
        try {
          const out = await tool.run(args, ctx);
          const text = typeof out === 'string' ? out : JSON.stringify(out, (k, v) => (v === undefined ? undefined : v), 2);
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

module.exports = { createMcp, runStdio, INSTRUCTIONS, VERSION };
