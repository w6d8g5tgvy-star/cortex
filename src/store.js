'use strict';
// Vault store: every project, task and note is a Markdown file on disk.
// The vault is a normal folder you can also open in Obsidian.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { parse, stringify } = require('./frontmatter');

const DIRS = { project: 'projects', task: 'tasks', note: 'notes' };
const ENUMS = {
  task: { status: ['todo', 'doing', 'blocked', 'done'], priority: ['low', 'medium', 'high', 'urgent'] },
  project: { status: ['active', 'paused', 'done', 'archived'] },
  note: { type: ['note', 'memory', 'decision', 'plan', 'log', 'reference', 'idea'] },
};
const SKIP = new Set(['id', 'kind', 'slug', 'title', 'body', 'append', 'links', 'backlinks', 'created', 'updated', 'allTags', 'excerpt', 'path', 'broken']);
const STATUS_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };
const PRIO_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const PROJ_ORDER = { active: 0, paused: 1, done: 2, archived: 3 };

const now = () => new Date().toISOString();
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const firstH1 = (body) => { const m = String(body).match(/^#\s+(.+)$/m); return m ? m[1].trim() : null; };
const asArray = (v) => {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean);
  return String(v).split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
};
const WIKI = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const HASHTAG = /(^|\s)#([a-zA-Z][\w\-/]*)/g;

class Store extends EventEmitter {
  constructor(vault) {
    super();
    this.setMaxListeners(200);
    this.vault = path.resolve(vault);
    this.items = new Map();
    this.activity = [];
    this.actFile = path.join(this.vault, '.cortex', 'activity.jsonl');
    this.actSize = 0;
    for (const d of ['projects', 'tasks', 'notes', '.cortex/trash']) fs.mkdirSync(path.join(this.vault, d), { recursive: true });
    this.scan(true);
    this.loadActivity(true);
    if (this.items.size === 0 && !fs.existsSync(path.join(this.vault, '.cortex', 'seeded'))) this.seed();
    this.timer = setInterval(() => { this.scan(false); this.loadActivity(false); }, 2000);
    this.timer.unref();
  }

  // ---------- disk sync ----------
  walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(p, out);
      else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
    }
  }

  kindOf(id) {
    const top = id.split('/')[0];
    return top === 'projects' ? 'project' : top === 'tasks' ? 'task' : 'note';
  }

  fileOf(id) { return path.join(this.vault, ...id.split('/')) + '.md'; }

  scan(initial) {
    const files = [];
    this.walk(this.vault, files);
    const seen = new Set();
    let changed = false;
    for (const f of files) {
      const id = path.relative(this.vault, f).split(path.sep).join('/').replace(/\.md$/i, '');
      seen.add(id);
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      const cur = this.items.get(id);
      if (cur && cur.mtime === st.mtimeMs) continue;
      try {
        const { meta, body } = parse(fs.readFileSync(f, 'utf8'));
        const rec = { id, kind: this.kindOf(id), slug: path.basename(id), meta, body, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.mtimeMs };
        this.index(rec);
        this.items.set(id, rec);
        changed = true;
      } catch { /* unreadable file; skip */ }
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) { this.items.delete(id); changed = true; }
    if (changed) {
      this.relink();
      if (!initial) this.emit('change', { type: 'sync' });
    }
    return changed;
  }

  loadActivity(initial) {
    let st;
    try { st = fs.statSync(this.actFile); } catch { return; }
    if (st.size === this.actSize) return;
    if (st.size < this.actSize) { this.actSize = 0; this.activity = []; }
    const fd = fs.openSync(this.actFile, 'r');
    const buf = Buffer.alloc(st.size - this.actSize);
    fs.readSync(fd, buf, 0, buf.length, this.actSize);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return;
    this.actSize += Buffer.byteLength(text.slice(0, lastNl + 1));
    let added = 0;
    for (const line of text.slice(0, lastNl).split('\n')) {
      if (!line.trim()) continue;
      try { this.activity.push(JSON.parse(line)); added++; } catch { /* ignore */ }
    }
    if (this.activity.length > 5000) this.activity = this.activity.slice(-5000);
    if (added && !initial) this.emit('change', { type: 'activity' });
  }

  index(rec) {
    rec.title = String(rec.meta.title || rec.meta.name || firstH1(rec.body) || rec.slug.replace(/-/g, ' '));
    rec.tags = asArray(rec.meta.tags);
    const inline = [];
    String(rec.body).replace(HASHTAG, (_, __, t) => { inline.push(t); return _; });
    rec.allTags = [...new Set([...rec.tags, ...inline])];
    rec.created = rec.meta.created || new Date(rec.ctime || Date.now()).toISOString();
    rec.updated = rec.meta.updated || new Date(rec.mtime || Date.now()).toISOString();
  }

  relink() {
    const bySlug = new Map();
    const byTitle = new Map();
    for (const r of this.items.values()) {
      if (!bySlug.has(r.slug.toLowerCase())) bySlug.set(r.slug.toLowerCase(), r.id);
      if (!byTitle.has(r.title.toLowerCase())) byTitle.set(r.title.toLowerCase(), r.id);
    }
    this._bySlug = bySlug;
    this._byTitle = byTitle;
    for (const r of this.items.values()) {
      const links = new Set();
      const broken = new Set();
      String(r.body).replace(WIKI, (_, ref) => {
        const id = this.resolve(ref);
        if (id && id !== r.id) links.add(id); else if (!id) broken.add(ref.trim());
        return _;
      });
      r.links = [...links];
      r.broken = [...broken];
    }
  }

  resolve(ref) {
    if (!ref) return null;
    let s = String(ref).trim().replace(/\.md$/i, '').replace(/\\/g, '/');
    if (this.items.has(s)) return s;
    const low = s.toLowerCase();
    if (this._bySlug && this._bySlug.has(low)) return this._bySlug.get(low);
    if (this._byTitle && this._byTitle.has(low)) return this._byTitle.get(low);
    const base = low.split('/').pop();
    if (this._bySlug && this._bySlug.has(base)) return this._bySlug.get(base);
    const sl = slugify(s);
    if (this._bySlug && this._bySlug.has(sl)) return this._bySlug.get(sl);
    return null;
  }

  resolveProject(ref) {
    if (ref === undefined || ref === null || ref === '') return undefined;
    const s = String(ref).trim().replace(/^projects\//, '');
    if (this.items.has('projects/' + s)) return s;
    if (this.items.has('projects/' + slugify(s))) return slugify(s);
    for (const r of this.items.values()) if (r.kind === 'project' && r.title.toLowerCase() === s.toLowerCase()) return r.slug;
    throw new Error(`Unknown project "${ref}". Use project_list to see projects or project_create to make one.`);
  }

  // ---------- serialization ----------
  toJSON(rec, { body = true } = {}) {
    if (!rec) return null;
    const { title, ...meta } = rec.meta;
    const out = { ...meta, id: rec.id, kind: rec.kind, slug: rec.slug, title: rec.title, tags: rec.tags, allTags: rec.allTags, links: rec.links || [], created: rec.created, updated: rec.updated };
    delete out.name;
    if (body) out.body = rec.body;
    else {
      out.excerpt = String(rec.body).replace(/^#.*$/m, '').replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*`~>#]+/g, '').replace(/^\s*[-+]\s+(\[.\]\s+)?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    }
    return out;
  }

  write(rec) {
    const file = this.fileOf(rec.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringify(rec.meta, rec.body));
    const st = fs.statSync(file);
    rec.mtime = st.mtimeMs;
    this.index(rec);
    this.items.set(rec.id, rec);
    this.relink();
  }

  clean(kind, data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (SKIP.has(k) || !/^[A-Za-z0-9_\-]+$/.test(k)) continue;
      if (v === null || v === '') { out[k] = undefined; continue; }
      if (k === 'tags') { out.tags = asArray(v); continue; }
      if (k === 'project') { out.project = this.resolveProject(v); continue; }
      const allowed = ENUMS[kind] && ENUMS[kind][k];
      if (allowed && !allowed.includes(String(v))) throw new Error(`Invalid ${k} "${v}". Use one of: ${allowed.join(', ')}`);
      out[k] = typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
    }
    return out;
  }

  // ---------- CRUD ----------
  get(ref) {
    const id = this.items.has(ref) ? ref : this.resolve(ref);
    return id ? this.items.get(id) : null;
  }

  must(ref) {
    const r = this.get(ref);
    if (!r) throw new Error(`Not found: "${ref}"`);
    return r;
  }

  create(kind, data = {}) {
    if (!DIRS[kind]) throw new Error(`Unknown kind "${kind}"`);
    const title = String(data.title || '').trim();
    if (!title) throw new Error('title is required');
    const base = slugify(title) || kind;
    let slug = base;
    let n = 2;
    while (this.items.has(`${DIRS[kind]}/${slug}`) || fs.existsSync(this.fileOf(`${DIRS[kind]}/${slug}`))) slug = `${base}-${n++}`;
    const id = `${DIRS[kind]}/${slug}`;
    const defaults = kind === 'task' ? { status: 'todo', priority: 'medium' } : kind === 'project' ? { status: 'active' } : { type: 'note' };
    const meta = { title, ...defaults };
    for (const [k, v] of Object.entries(this.clean(kind, data))) if (v !== undefined) meta[k] = v;
    if (kind === 'task' && meta.status === 'done') meta.completed = now();
    meta.created = meta.updated = now();
    const rec = { id, kind, slug, meta, body: data.body ? String(data.body) : '', ctime: Date.now() };
    this.write(rec);
    this.emit('change', { type: 'create', id, kind });
    return rec;
  }

  update(ref, patch = {}) {
    const rec = this.must(ref);
    if (patch.title !== undefined) {
      const t = String(patch.title).trim();
      if (!t) throw new Error('title cannot be empty');
      rec.meta.title = t;
    }
    if (patch.body !== undefined && patch.body !== null) rec.body = String(patch.body);
    if (patch.append) {
      const cur = String(rec.body).replace(/\s+$/, '');
      rec.body = (cur ? cur + '\n\n' : '') + String(patch.append) + '\n';
    }
    const prevStatus = rec.meta.status;
    for (const [k, v] of Object.entries(this.clean(rec.kind, patch))) {
      if (v === undefined) delete rec.meta[k]; else rec.meta[k] = v;
    }
    if (rec.kind === 'task' && rec.meta.status !== prevStatus) {
      if (rec.meta.status === 'done') rec.meta.completed = now(); else delete rec.meta.completed;
    }
    // keep created/updated at the end of the front-matter
    const { created, updated, ...rest } = rec.meta;
    rec.meta = { ...rest, created: created || rec.created, updated: now() };
    this.write(rec);
    this.emit('change', { type: 'update', id: rec.id, kind: rec.kind });
    return rec;
  }

  remove(ref) {
    const rec = this.must(ref);
    const dest = path.join(this.vault, '.cortex', 'trash', `${rec.id.replace(/\//g, '__')}__${Date.now()}.md`);
    try { fs.renameSync(this.fileOf(rec.id), dest); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.items.delete(rec.id);
    this.relink();
    this.emit('change', { type: 'delete', id: rec.id, kind: rec.kind });
    return rec;
  }

  backlinks(id) {
    const out = [];
    for (const r of this.items.values()) if (r.links && r.links.includes(id)) out.push(r);
    return out;
  }

  // ---------- queries ----------
  list(kind, f = {}) {
    let arr = [...this.items.values()].filter((r) => !kind || r.kind === kind);
    if (f.project) { const p = String(f.project).replace(/^projects\//, ''); arr = arr.filter((r) => r.meta.project === p || r.meta.project === slugify(p)); }
    if (f.status) { const s = asArray(f.status); arr = arr.filter((r) => s.includes(r.meta.status)); }
    if (f.open) arr = arr.filter((r) => r.meta.status !== 'done');
    if (f.type) { const t = asArray(f.type); arr = arr.filter((r) => t.includes(r.meta.type || 'note')); }
    if (f.tag) { const t = String(f.tag).replace(/^#/, '').toLowerCase(); arr = arr.filter((r) => r.allTags.some((x) => x.toLowerCase() === t)); }
    if (f.assignee) arr = arr.filter((r) => String(r.meta.assignee || '').toLowerCase() === String(f.assignee).toLowerCase());
    const byUpdated = (a, b) => (a.updated < b.updated ? 1 : -1);
    if (kind === 'task') arr.sort((a, b) => (STATUS_ORDER[a.meta.status] ?? 9) - (STATUS_ORDER[b.meta.status] ?? 9) || (PRIO_ORDER[a.meta.priority] ?? 9) - (PRIO_ORDER[b.meta.priority] ?? 9) || byUpdated(a, b));
    else if (kind === 'project') arr.sort((a, b) => (PROJ_ORDER[a.meta.status] ?? 9) - (PROJ_ORDER[b.meta.status] ?? 9) || a.title.localeCompare(b.title));
    else arr.sort((a, b) => (b.meta.pinned === true) - (a.meta.pinned === true) || byUpdated(a, b));
    if (f.limit) arr = arr.slice(0, Number(f.limit));
    return arr;
  }

  search(q, f = {}) {
    const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const phrase = tokens.join(' ');
    const pool = f.kind ? this.list(f.kind, f) : [...this.list('note', f), ...this.list('task', f), ...this.list('project', f)];
    const hits = [];
    for (const r of pool) {
      const title = r.title.toLowerCase();
      const body = String(r.body).toLowerCase();
      const tags = r.allTags.join(' ').toLowerCase();
      let score = 0;
      let ok = true;
      for (const t of tokens) {
        let s = 0;
        if (title.includes(t)) s += 6;
        if (tags.includes(t)) s += 4;
        if (r.id.toLowerCase().includes(t)) s += 1;
        let idx = body.indexOf(t);
        let c = 0;
        while (idx >= 0 && c < 8) { c++; idx = body.indexOf(t, idx + t.length); }
        s += c;
        if (!s) { ok = false; break; }
        score += s;
      }
      if (!ok) continue;
      if (title.includes(phrase)) score += 8;
      if (body.includes(phrase) && tokens.length > 1) score += 4;
      const at = body.indexOf(tokens[0]);
      const snippet = at >= 0 ? String(r.body).slice(Math.max(0, at - 70), at + 130).replace(/\s+/g, ' ').trim() : String(r.body).slice(0, 160).replace(/\s+/g, ' ').trim();
      hits.push({ score, rec: r, snippet });
    }
    hits.sort((a, b) => b.score - a.score || (a.rec.updated < b.rec.updated ? 1 : -1));
    return hits.slice(0, Number(f.limit) || 20);
  }

  projectStats(slug) {
    const counts = { todo: 0, doing: 0, blocked: 0, done: 0, total: 0 };
    for (const r of this.items.values()) {
      if (r.kind === 'task' && r.meta.project === slug) { counts[r.meta.status] = (counts[r.meta.status] || 0) + 1; counts.total++; }
    }
    counts.notes = [...this.items.values()].filter((r) => r.kind === 'note' && r.meta.project === slug).length;
    counts.progress = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
    return counts;
  }

  stats() {
    const all = [...this.items.values()];
    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    return {
      projects: all.filter((r) => r.kind === 'project' && r.meta.status === 'active').length,
      openTasks: all.filter((r) => r.kind === 'task' && r.meta.status !== 'done').length,
      doneTasks: all.filter((r) => r.kind === 'task' && r.meta.status === 'done').length,
      notes: all.filter((r) => r.kind === 'note').length,
      actions24h: this.activity.filter((a) => a.ts >= dayAgo).length,
      agents: [...new Set(this.activity.map((a) => a.agent))].length,
    };
  }

  graph() {
    const nodes = [];
    const edges = [];
    for (const r of this.items.values()) {
      nodes.push({ id: r.id, kind: r.kind, title: r.title, status: r.meta.status, type: r.meta.type, project: r.meta.project, color: r.meta.color });
      for (const l of r.links || []) edges.push({ source: r.id, target: l, type: 'link' });
      if (r.meta.project && this.items.has('projects/' + r.meta.project)) edges.push({ source: r.id, target: 'projects/' + r.meta.project, type: 'project' });
    }
    return { nodes, edges };
  }

  // ---------- activity ----------
  log(entry) {
    const e = {
      ts: now(),
      agent: String(entry.agent || 'user').slice(0, 80),
      action: String(entry.action || 'note').slice(0, 60),
      summary: String(entry.summary || '').slice(0, 2000),
    };
    if (entry.project) e.project = String(entry.project);
    if (entry.ref) e.ref = String(entry.ref);
    fs.mkdirSync(path.dirname(this.actFile), { recursive: true });
    fs.appendFileSync(this.actFile, JSON.stringify(e) + '\n');
    this.loadActivity(false);
    return e;
  }

  recentActivity(f = {}) {
    let a = this.activity;
    if (f.agent) a = a.filter((x) => x.agent === f.agent);
    if (f.project) a = a.filter((x) => x.project === f.project);
    return a.slice(-(Number(f.limit) || 50)).reverse();
  }

  // ---------- first-run content ----------
  seed() {
    const p = this.create('project', { title: 'Getting Started', description: 'Learn how Cortex works and connect your first AI agent.', color: '#8b7cf6' });
    this.create('task', { title: 'Connect an AI agent over MCP', project: p.slug, status: 'doing', priority: 'high', tags: ['setup'], body: 'Open the **Agents** tab in the dashboard and copy the config for your tool (Claude Desktop, Claude Code, Cursor, Codex, VS Code...).' });
    this.create('task', { title: 'Write your first memory', project: p.slug, priority: 'medium', body: 'Go to **Memory**, click **New**, and link to another note with `[[Welcome to Cortex]]`.' });
    this.create('task', { title: 'Open the vault folder in Obsidian (optional)', project: p.slug, priority: 'low', tags: ['obsidian'] });
    this.create('task', { title: 'Explore the knowledge graph', project: p.slug, status: 'done', priority: 'low' });
    this.create('note', {
      title: 'Welcome to Cortex', type: 'reference', project: p.slug, tags: ['cortex', 'guide'], pinned: true,
      body: [
        '# Welcome to Cortex',
        '',
        'Cortex is a local **project manager + long-term memory** that both you and your AI agents share.',
        '',
        '## How it works',
        '- Everything is stored as plain Markdown files in your vault folder, so it works with Obsidian too.',
        '- Link notes together with wikilinks like [[Agent Memory Guide]]. Backlinks and the graph update automatically.',
        '- Tag things inline with #tags or in the tags field.',
        '- AI agents connect over **MCP** and can read and write projects, tasks and memories, and log what they did.',
        '',
        '## Next steps',
        '- [ ] Connect an agent from the **Agents** tab',
        '- [ ] Create a project for something you are working on',
        '- [x] Install Cortex',
      ].join('\n'),
    });
    this.create('note', {
      title: 'Agent Memory Guide', type: 'memory', tags: ['cortex', 'agents'],
      body: [
        '# Agent Memory Guide',
        '',
        'Rules agents follow when they use Cortex (also sent to them when they connect):',
        '',
        '1. Call `cortex_start` at the beginning of a session to load projects, open tasks and recent memories.',
        '2. Search memory with `memory_search` before asking the user something you might already know.',
        '3. Save durable knowledge (decisions, preferences, facts, how-tos) with `memory_write`.',
        '4. Keep tasks current with `task_update`, moving them todo → doing → done.',
        '5. Record meaningful work with `activity_log` so humans can see what happened.',
        '',
        'See also [[Welcome to Cortex]].',
      ].join('\n'),
    });
    fs.writeFileSync(path.join(this.vault, '.cortex', 'seeded'), now());
    this.log({ agent: 'cortex', action: 'setup', summary: 'Vault created with a Getting Started project.' });
  }
}

module.exports = { Store, ENUMS, slugify };
