'use strict';
// Vault store: every project, task and note is a Markdown file on disk.
// The vault is a normal folder you can also open in Obsidian.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { parse, stringify } = require('./frontmatter');

const DIRS = { project: 'projects', task: 'tasks', note: 'notes', mind: 'mind', skill: 'skills' };
const ENUMS = {
  task: { status: ['todo', 'doing', 'blocked', 'done'], priority: ['low', 'medium', 'high', 'urgent'] },
  project: { status: ['active', 'paused', 'done', 'archived'] },
  note: { type: ['note', 'memory', 'decision', 'plan', 'log', 'reference', 'idea'] },
  mind: { section: ['watch', 'read', 'write'], status: ['queued', 'fetched', 'processing', 'done', 'failed'] },
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
const STOP = new Set('the and for are but not you all any can had her was one our out has have him his how its may new now old see two who did get let say she too use with that this from they will what when your were been than them then into more some such only also just over very about would there their which could other after those these where while'.split(' '));
function stem(w) {
  if (w.length <= 4) return w;
  return w.replace(/(ational|ization|fulness|ousness|iveness)$/, (m) => ({ ational: 'ate', ization: 'ize', fulness: 'ful', ousness: 'ous', iveness: 'ive' }[m]))
    .replace(/(ments?|ings?|edly|ed|ly|ers?|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')).replace(/(.)\1$/, '$1');
}
function tokenize(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem); }
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
    for (const d of ['projects', 'tasks', 'notes', 'mind', 'skills', '.cortex/trash']) fs.mkdirSync(path.join(this.vault, d), { recursive: true });
    this.scan(true);
    this.loadActivity(true);
    if (this.items.size === 0 && !fs.existsSync(path.join(this.vault, '.cortex', 'seeded'))) this.seed();
    this.organizeMemories();
    this.timer = setInterval(() => { this.scan(false); this.loadActivity(false); }, 2000);
    this.timer.unref();
  }

  // ---------- disk sync ----------
  walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      // Fetcher's full reports live in <vault>/fetcher/ for reading in Obsidian; they are not memories
      // (the lesson notes are), so agents never pay tokens for them.
      if (dir === this.vault && e.name === 'fetcher' && e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(p, out);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
    }
  }

  kindOf(id) {
    const top = id.split('/')[0];
    return top === 'projects' ? 'project' : top === 'tasks' ? 'task' : top === 'mind' ? 'mind' : top === 'skills' ? 'skill' : 'note';
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
        if (rec.kind === 'note' && !meta.project) {
          const m = id.match(/^notes\/([^/]+)\/[^/]+$/);
          if (m && fs.existsSync(this.fileOf('projects/' + m[1]))) meta.project = m[1]; // a file dropped into a project folder belongs to it
        }
        if (rec.kind === 'project' && /^projects\/[^/]+$/.test(id)) this.ensureProjectMemory(rec.slug);
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
    require('./backup').snapshot(this.vault, rec.id, file); // keep the previous version
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
    let r = this.get(ref);
    if (!r) { this.scan(false); r = this.get(ref); } // another process (an agent's MCP server, a hook) may have just written it
    if (!r) throw new Error(`Not found: "${ref}"`);
    return r;
  }

  create(kind, data = {}) {
    if (!DIRS[kind]) throw new Error(`Unknown kind "${kind}"`);
    const title = String(data.title || '').trim();
    if (!title) throw new Error('title is required');
    const cleaned = this.clean(kind, data);
    const dir = this.dirFor(kind, cleaned.project);
    const slug = this.freeSlug(dir, slugify(title) || kind);
    const id = `${dir}/${slug}`;
    const defaults = kind === 'task' ? { status: 'todo', priority: 'medium' } : kind === 'project' ? { status: 'active' } : kind === 'mind' ? { section: 'watch', status: 'queued' } : kind === 'skill' ? {} : { type: 'note' };
    const meta = { title, ...defaults };
    for (const [k, v] of Object.entries(cleaned)) if (v !== undefined) meta[k] = v;
    if (kind === 'task' && meta.status === 'done') meta.completed = now();
    meta.created = meta.updated = now();
    const rec = { id, kind, slug, meta, body: data.body ? String(data.body) : '', ctime: Date.now() };
    if (kind === 'project') this.ensureProjectMemory(slug);
    this.write(rec);
    this.emit('change', { type: 'create', id, kind });
    return rec;
  }

  // ---------- memory scopes ----------
  // Project memories live in notes/<project>/ and only apply to that project.
  // System memories live directly in notes/ and apply to every project.
  ensureProjectMemory(slug) { fs.mkdirSync(path.join(this.vault, 'notes', slug), { recursive: true }); }

  dirFor(kind, project) { return kind === 'note' && project ? `notes/${project}` : DIRS[kind]; }

  freeSlug(dir, base) {
    let slug = base;
    let n = 2;
    while (this.items.has(`${dir}/${slug}`) || fs.existsSync(this.fileOf(`${dir}/${slug}`))) slug = `${base}-${n++}`;
    return slug;
  }

  /** Move a note's file into the folder that matches its scope. Returns the (possibly new) record. */
  relocate(rec) {
    if (rec.kind !== 'note') return rec;
    const want = this.dirFor('note', rec.meta.project && this.items.has('projects/' + rec.meta.project) ? rec.meta.project : undefined);
    const curDir = rec.id.split('/').slice(0, -1).join('/');
    if (curDir === want) return rec;
    // notes in other sub-folders that aren't project folders (e.g. your own Obsidian folders) stay where they are
    if (curDir !== 'notes' && !/^notes\/[^/]+$/.test(curDir)) return rec;
    if (curDir !== 'notes' && !this.items.has('projects/' + curDir.split('/')[1]) && !rec.meta.project) return rec;
    const slug = this.freeSlug(want, rec.slug);
    const newId = `${want}/${slug}`;
    fs.mkdirSync(path.dirname(this.fileOf(newId)), { recursive: true });
    fs.renameSync(this.fileOf(rec.id), this.fileOf(newId));
    this.items.delete(rec.id);
    const moved = { ...rec, id: newId, slug };
    moved.mtime = fs.statSync(this.fileOf(newId)).mtimeMs;
    this.items.set(newId, moved);
    this.relink();
    this.emit('change', { type: 'move', id: newId, from: rec.id, kind: 'note' });
    return moved;
  }

  /** One-time tidy: put project notes into their project folders and make sure every project has one. */
  organizeMemories() {
    for (const p of this.list('project')) fs.mkdirSync(path.join(this.vault, 'notes', p.slug), { recursive: true });
    for (const r of [...this.items.values()]) {
      if (r.kind !== 'note') continue;
      try { this.relocate(r); } catch { /* leave it */ }
    }
  }

  scopeOf(rec) { return rec.kind === 'note' && rec.meta.project ? 'project' : 'system'; }

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
    const out = this.relocate(rec);
    this.emit('change', { type: 'update', id: out.id, kind: out.kind });
    return out;
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
    if (f.scope === 'system') arr = arr.filter((r) => r.kind !== 'note' || !r.meta.project);
    if (f.scope === 'project+system' && f.projectScope) arr = arr.filter((r) => r.kind !== 'note' || !r.meta.project || r.meta.project === f.projectScope);
    if (f.section) { const t = asArray(f.section); arr = arr.filter((r) => t.includes(r.meta.section)); }
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
    // BM25 ranking over title (×3), tags (×2) and body, with light stemming and prefix matching,
    // so "deploying" finds "deployment" and partial words still hit. Results need ≥ half the words.
    const qt = [...new Set(tokenize(q))];
    if (!qt.length) return [];
    // `limit` caps the RESULTS, never the candidates: rank every matching record first.
    // (Before 2.1.1 it was passed to list(), so a search only saw the N most recently updated notes.)
    const pf = { ...f, limit: undefined };
    const pool = f.kind ? this.list(f.kind, pf) : [...this.list('note', pf), ...this.list('mind', pf), ...this.list('task', pf), ...this.list('project', pf)];
    const docs = pool.map((r) => {
      const title = tokenize(r.title); const tags = tokenize(r.allTags.join(' ')); const body = tokenize(r.body);
      const tf = new Map();
      const add = (arr, w) => { for (const t of arr) tf.set(t, (tf.get(t) || 0) + w); };
      add(title, 3); add(tags, 2); add(body, 1);
      return { r, tf, len: title.length * 3 + tags.length * 2 + body.length };
    });
    const N = docs.length || 1;
    const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
    const termHits = (d, t) => { let v = d.tf.get(t) || 0; if (!v && t.length >= 4) for (const [k, c] of d.tf) if ((k.length > t.length && k.startsWith(t)) || (k.length >= 5 && t.length > k.length && t.startsWith(k))) v += c * 0.6; return v; };
    const df = new Map(qt.map((t) => [t, docs.filter((d) => termHits(d, t) > 0).length]));
    const phrase = String(q).toLowerCase().trim();
    const hits = [];
    for (const d of docs) {
      let score = 0; let matched = 0;
      for (const t of qt) {
        const tf = termHits(d, t);
        if (!tf) continue;
        matched++;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / avg))));
      }
      if (!matched || matched < (f.minMatch || Math.ceil(qt.length / 2))) continue;
      if (d.r.title.toLowerCase().includes(phrase)) score += 3;
      else if (qt.length > 1 && String(d.r.body).toLowerCase().includes(phrase)) score += 1.5;
      score *= 1 + (matched / qt.length - 0.5) * 0.6;
      const body = String(d.r.body);
      const low = body.toLowerCase();
      const firstRaw = String(q).toLowerCase().split(/\s+/).find((w) => w.length > 2 && low.includes(w));
      const at = firstRaw ? low.indexOf(firstRaw) : -1;
      const snippet = at >= 0 ? body.slice(Math.max(0, at - 70), at + 130).replace(/\s+/g, ' ').trim() : body.replace(/^#.*$/m, '').slice(0, 160).replace(/\s+/g, ' ').trim();
      hits.push({ score: Math.round(score * 100) / 10, rec: d.r, snippet });
    }
    hits.sort((a, b) => b.score - a.score || (a.rec.updated < b.rec.updated ? 1 : -1));
    return hits.slice(0, Number(f.limit) || 20);
  }

  /** The passage of a record that best answers `q`: the paragraph or list item with the most query terms,
   *  grown with its neighbours (and its section heading) up to `max` characters. Lets an agent read the
   *  answer straight from a search result instead of spending a turn on memory_get. */
  passage(rec, q, max = 700) {
    const qt = new Set(tokenize(q));
    const body = String(rec.body || '').replace(/^---[\s\S]*?---\s*/, '');
    const lines = body.split(/\r?\n/);
    const blocks = []; // paragraphs and list items, with their nearest heading
    let heading = ''; let headLine = ''; let cur = [];
    const flush = () => { if (cur.length) blocks.push({ heading, headLine, text: cur.join('\n') }); cur = []; };
    for (const ln of lines) {
      if (/^#{1,6}\s/.test(ln)) { flush(); heading = ln.replace(/^#+\s*/, '').trim(); headLine = ln.trim(); continue; }
      if (!ln.trim()) { flush(); continue; }
      if (/^\s*([-*+]|\d+\.)\s/.test(ln) && cur.length && !/^\s/.test(ln)) flush();
      cur.push(ln);
    }
    flush();
    if (!blocks.length) return '';
    // Score = query words in the paragraph, each weighted by how rare it is within this note (words that are
    // everywhere in the note, or in its title, say little). Wikilink text doesn't count ("Related: [[…]]" lines
    // repeat titles), the section heading counts half, and the note's # title not at all.
    // Prefix matching like search(): the light stemmer gives "removes" → "remov" but leaves "remove" as is.
    const qList = [...qt];
    const match = (t) => (qt.has(t) ? t : qList.find((q) => Math.min(q.length, t.length) >= 5 && (q.startsWith(t) || t.startsWith(q))));
    const hits = (text) => { const s = new Set(); for (const t of tokenize(String(text).replace(WIKI, ' '))) { const m = match(t); if (m) s.add(m); } return s; };
    const df = new Map();
    const blockHits = blocks.map((b) => { const h = hits(b.text); for (const t of h) df.set(t, (df.get(t) || 0) + 1); return h; });
    const titleWords = hits(rec.title);
    const w = (t) => Math.log(1 + blocks.length / (1 + (df.get(t) || 0))) * (titleWords.has(t) ? 0.3 : 1);
    const scoreAt = (i) => { const b = blocks[i]; let s = 0; for (const t of blockHits[i]) s += w(t); if (!/^#\s/.test(b.headLine)) for (const t of hits(b.heading)) if (!blockHits[i].has(t)) s += 0.5 * w(t); return s; };
    const score = (b) => scoreAt(blocks.indexOf(b));
    let best = 0; let bestS = -1;
    blocks.forEach((b, i) => { const s = score(b); if (s > bestS) { bestS = s; best = i; } });
    if (bestS <= 0) return '';
    let lo = best; let hi = best;
    let text = blocks[best].text;
    while (text.length < max) {
      const canUp = lo > 0 && blocks[lo - 1].heading === blocks[best].heading;
      const canDown = hi < blocks.length - 1 && blocks[hi + 1].heading === blocks[best].heading;
      if (!canUp && !canDown) break;
      const up = canUp ? score(blocks[lo - 1]) : -1; const down = canDown ? score(blocks[hi + 1]) : -1;
      if (down >= up && canDown) { if ((text + '\n' + blocks[hi + 1].text).length > max) break; text += '\n' + blocks[++hi].text; }
      else { if ((blocks[lo - 1].text + '\n' + text).length > max) break; text = blocks[--lo].text + '\n' + text; }
    }
    // The heading is shown as the note wrote it (e.g. "### 14:05 · codex · ✓ finished"): headings are often the
    // very format an agent must copy, so rewriting them (Train AI round 3 found "[…]" being copied) teaches it wrong.
    const head = blocks[best].headLine ? blocks[best].headLine + '\n' : '';
    return (head + text).slice(0, max + 80);
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
      mindQueued: all.filter((r) => r.kind === 'mind' && ['queued', 'fetched'].includes(r.meta.status)).length,
      actions24h: this.activity.filter((a) => a.ts >= dayAgo).length,
      agents: [...new Set(this.activity.filter((a) => a.action !== 'connect' && !/^(you|cortex)/.test(a.agent)).map((a) => a.agent))].length,
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
      summary: require('./redact').redact(String(entry.summary || ''), this.vault).slice(0, 2000),
    };
    if (entry.project) e.project = String(entry.project);
    if (entry.ref) e.ref = String(entry.ref);
    if (entry.model) e.model = String(entry.model).slice(0, 80);
    fs.mkdirSync(path.dirname(this.actFile), { recursive: true });
    fs.appendFileSync(this.actFile, JSON.stringify(e) + '\n');
    // every agent action on a project also lands in that project's agent journal
    if (e.project && !/^(you|cortex)\b/.test(e.agent) && !/^(run\.|connect|setup|settings)/.test(e.action)) {
      try { require('./journal').line(this.vault, e.project, e.agent, e.summary); } catch { /* never block logging */ }
    }
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

module.exports = { Store, ENUMS, slugify, tokenize };
