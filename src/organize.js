'use strict';
// Automatic project organization (2.3, checklist #33). Finds tidy-up work and proposes it; you approve each change
// (or allow some kinds to be applied automatically). Nothing is ever deleted, and every change to a memory or task is
// a normal edit, so it shows in Undo and in the item's history.
//   tag         add tags you already use elsewhere to a memory that matches them
//   project     file a memory with no project under the project it's clearly about
//   related     link two closely related memories to each other ("Related: [[…]]")
//   duplicate   mark likely duplicates so you can merge them (both are kept)
//   outdated    flag an old memory when a newer one covers the same topic
//   file        move a file from attachments/inbox to the project folder it belongs to
//   priority    raise overdue or blocking tasks; lower tasks untouched for months
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 864e5;
const STOP = new Set('the and for with this that from into your you our are was were has have had not but all any can will about what when which there their them they then than also just more most some such only over very use used using make made how why who out its it’s get got one two new old'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
const sid = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
const KINDS = ['tag', 'project', 'related', 'duplicate', 'outdated', 'file', 'priority'];
const SAFE_AUTO = ['tag', 'related', 'project', 'file']; // kinds that may be allowed to run on their own (never priority/duplicate/outdated)

const stateFile = (vault) => path.join(vault, '.cortex', 'organize.json');
function loadState(vault) { try { return JSON.parse(fs.readFileSync(stateFile(vault), 'utf8')); } catch { return { dismissed: [], applied: [] }; } }
function saveState(vault, s) { fs.mkdirSync(path.dirname(stateFile(vault)), { recursive: true }); fs.writeFileSync(stateFile(vault), JSON.stringify({ dismissed: s.dismissed.slice(-2000), applied: s.applied.slice(-500) }, null, 1)); }

/** Everything worth tidying, newest ideas first. Dismissed suggestions don't come back. */
function suggest(store, { now = Date.now(), limit = 80 } = {}) {
  const vault = store.vault; const st = loadState(vault); const gone = new Set([...st.dismissed, ...st.applied.map((a) => a.id)]);
  const out = []; const add = (s) => { if (!gone.has(s.id)) out.push(s); };
  const notes = store.list('note').filter((n) => !n.meta.agent_journal && !n.meta.pinned_system);
  const projects = store.list('project').filter((p) => p.meta.status !== 'archived');
  const W = new Map(notes.map((n) => [n.id, { t: words(n.title), b: words(String(n.body).slice(0, 4000)) }]));

  // --- tags: only tags already used on 2+ items, matched as whole words in title/body ---
  const tagUse = new Map();
  for (const r of [...notes, ...store.list('task')]) for (const t of r.tags || []) tagUse.set(t, (tagUse.get(t) || 0) + 1);
  const vocab = [...tagUse].filter(([t, c]) => c >= 2 && t.length >= 3 && !/^(chat|workflow|possible-duplicate|outdated)$/.test(t)).map(([t]) => t);
  for (const n of notes) {
    const have = new Set(n.tags || []); const text = ` ${W.get(n.id).t.join(' ')} ${W.get(n.id).b.join(' ')} `;
    const want = vocab.filter((t) => !have.has(t) && text.includes(` ${t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `)).slice(0, 3);
    if (want.length) add({ id: sid('tag', n.id, want.join(',')), kind: 'tag', title: `Tag "${n.title}" with ${want.map((t) => '#' + t).join(' ')}`, why: `It mentions ${want.join(', ')}, which you already use as tags elsewhere.`, ref: n.id, tags: want });
  }

  // --- project: unfiled memory that names exactly one project (title or slug) ---
  for (const n of notes.filter((x) => !x.meta.project)) {
    const text = `${n.title}\n${String(n.body).slice(0, 4000)}`.toLowerCase();
    const hits = projects.filter((p) => { const t = p.title.toLowerCase(); return (t.length >= 4 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) || (p.slug.length >= 4 && new RegExp(`\\b${p.slug}\\b`).test(text)); });
    if (hits.length === 1) add({ id: sid('project', n.id, hits[0].slug), kind: 'project', title: `File "${n.title}" under ${hits[0].title}`, why: `It's not in any project and talks about ${hits[0].title}.`, ref: n.id, project: hits[0].slug });
  }

  // --- related / duplicate / outdated: pairwise similarity (same project or unfiled) ---
  const linked = (a, b) => (a.links || []).includes(b.id) || (b.links || []).includes(a.id);
  const pairs = [];
  for (let i = 0; i < notes.length && i < 1500; i++) {
    const a = notes[i];
    for (let j = i + 1; j < notes.length && j < 1500; j++) {
      const b = notes[j];
      if (a.meta.project && b.meta.project && a.meta.project !== b.meta.project) continue;
      const ts = jaccard(W.get(a.id).t, W.get(b.id).t); const bs = jaccard(W.get(a.id).b.slice(0, 400), W.get(b.id).b.slice(0, 400));
      const sim = Math.max(ts, bs, (ts + bs) / 2);
      if (sim >= 0.25) pairs.push({ a, b, ts, bs, sim });
    }
  }
  for (const { a, b, ts, bs, sim } of pairs.sort((x, y) => y.sim - x.sim)) {
    const [older, newer] = new Date(a.updated) < new Date(b.updated) ? [a, b] : [b, a];
    // duplicates need the CONTENT to match too (same title + different text is usually a newer version, not a copy)
    const dup = (a.title.toLowerCase() === b.title.toLowerCase() && bs >= 0.3) || bs >= 0.8 || (ts >= 0.5 && bs >= 0.5);
    if (dup) { add({ id: sid('duplicate', a.id, b.id), kind: 'duplicate', title: `"${a.title}" and "${b.title}" look like duplicates`, why: `${Math.round(sim * 100)}% similar. Marking links them and tags both #possible-duplicate so you can merge them; nothing is deleted.`, ref: a.id, other: b.id }); continue; }
    if (ts >= 0.3 && now - new Date(older.updated).getTime() > 90 * DAY && new Date(newer.updated) - new Date(older.updated) > 30 * DAY && !(older.tags || []).includes('outdated')) {
      add({ id: sid('outdated', older.id, newer.id), kind: 'outdated', title: `"${older.title}" may be outdated`, why: `Last changed ${Math.round((now - new Date(older.updated).getTime()) / DAY)} days ago; "${newer.title}" covers the same topic and is newer.`, ref: older.id, other: newer.id });
      continue;
    }
    if (sim >= 0.3 && !linked(a, b)) add({ id: sid('related', a.id, b.id), kind: 'related', title: `Link "${a.title}" ↔ "${b.title}"`, why: `They're about the same thing (${Math.round(sim * 100)}% similar) but don't link to each other yet.`, ref: a.id, other: b.id });
  }

  // --- files waiting in attachments/inbox that name a project ---
  const inbox = path.join(vault, 'attachments', 'inbox');
  let files = []; try { files = fs.readdirSync(inbox).filter((f) => !f.startsWith('.')); } catch { /* none */ }
  for (const f of files) {
    let text = f.toLowerCase(); try { const full = path.join(inbox, f); if (fs.statSync(full).size < 200000 && /\.(md|txt|json|csv|js|ts|py|lua|html)$/i.test(f)) text += '\n' + fs.readFileSync(full, 'utf8').slice(0, 5000).toLowerCase(); } catch { /* unreadable */ }
    const hits = projects.filter((p) => (p.title.length >= 4 && text.includes(p.title.toLowerCase())) || (p.slug.length >= 4 && text.includes(p.slug)));
    if (hits.length === 1) add({ id: sid('file', f, hits[0].slug), kind: 'file', title: `Move ${f} to ${hits[0].title}'s files`, why: `It's in the inbox and mentions ${hits[0].title}.`, file: f, project: hits[0].slug });
  }

  // --- tasks: overdue or blocking → raise; untouched for months → lower ---
  let blockedBy = () => []; try { blockedBy = require('./orchestra').blockedBy; } catch { /* optional */ }
  const tasks = store.list('task').filter((t) => t.meta.status !== 'done');
  const blocking = new Map();
  for (const t of tasks) { let bl = []; try { bl = blockedBy(store, t) || []; } catch { bl = []; } for (const b of bl) { const id = b.id || b; blocking.set(id, (blocking.get(id) || 0) + 1); } }
  for (const t of tasks) {
    const pr = t.meta.priority || 'medium'; const due = t.meta.due ? Date.parse(t.meta.due) : NaN;
    if (Number.isFinite(due) && due < now && !['high', 'urgent'].includes(pr)) add({ id: sid('priority', t.id, 'overdue', t.meta.due), kind: 'priority', title: `Raise "${t.title}" to high`, why: `It was due ${new Date(due).toLocaleDateString()} and isn't done.`, ref: t.id, priority: 'high' });
    else if (blocking.get(t.id) >= 1 && ['low', 'medium'].includes(pr)) add({ id: sid('priority', t.id, 'blocks', blocking.get(t.id)), kind: 'priority', title: `Raise "${t.title}" to high`, why: `${blocking.get(t.id)} other task(s) are waiting for it.`, ref: t.id, priority: 'high' });
    else if (t.meta.status === 'todo' && pr !== 'low' && now - new Date(t.updated).getTime() > 75 * DAY) add({ id: sid('priority', t.id, 'idle', t.updated), kind: 'priority', title: `Lower "${t.title}" to low`, why: `Nobody has touched it for ${Math.round((now - new Date(t.updated).getTime()) / DAY)} days.`, ref: t.id, priority: 'low' });
  }
  const order = { priority: 0, duplicate: 1, outdated: 2, project: 3, file: 4, related: 5, tag: 6 };
  return out.sort((x, y) => order[x.kind] - order[y.kind]).slice(0, limit);
}

/** Apply one suggestion by id. It's looked up again, so only what Cortex itself proposed can be applied. */
function apply(store, id, { by = 'you' } = {}) {
  const s = suggest(store, { limit: 100000 }).find((x) => x.id === id);
  if (!s) throw new Error('That suggestion is no longer valid (it may already be done). Refresh the list.');
  const vault = store.vault; let summary = '';
  if (s.kind === 'tag') { const n = store.must(s.ref); store.update(n.id, { tags: [...new Set([...(n.tags || []), ...s.tags])] }); summary = `Tagged "${n.title}" with ${s.tags.join(', ')}`; }
  if (s.kind === 'project') { const n = store.must(s.ref); store.update(n.id, { project: s.project }); summary = `Filed "${n.title}" under ${s.project}`; }
  if (s.kind === 'related') { const a = store.must(s.ref); const b = store.must(s.other); store.update(a.id, { append: `Related: [[${b.title}]]` }); store.update(store.must(s.other).id, { append: `Related: [[${a.title}]]` }); summary = `Linked "${a.title}" and "${b.title}"`; }
  if (s.kind === 'duplicate') {
    const a = store.must(s.ref); const b = store.must(s.other);
    store.update(a.id, { tags: [...new Set([...(a.tags || []), 'possible-duplicate'])], append: `Possible duplicate of [[${b.title}]] (marked by Cortex; merge them when you have a moment).` });
    const b2 = store.must(s.other); store.update(b2.id, { tags: [...new Set([...(b2.tags || []), 'possible-duplicate'])], append: `Possible duplicate of [[${a.title}]] (marked by Cortex).` });
    summary = `Marked "${a.title}" and "${b.title}" as possible duplicates`;
  }
  if (s.kind === 'outdated') { const o = store.must(s.ref); const nw = store.must(s.other); store.update(o.id, { tags: [...new Set([...(o.tags || []), 'outdated'])], body: `> ⚠ Possibly outdated: see [[${nw.title}]] (flagged by Cortex ${new Date().toISOString().slice(0, 10)}).\n\n${o.body}` }); summary = `Flagged "${o.title}" as possibly outdated`; }
  if (s.kind === 'priority') { const t = store.must(s.ref); store.update(t.id, { priority: s.priority }); summary = `Set "${t.title}" to ${s.priority} priority`; }
  if (s.kind === 'file') {
    const from = path.join(vault, 'attachments', 'inbox', s.file);
    const dir = path.join(vault, 'attachments', s.project); fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, s.file); let k = 1; while (fs.existsSync(dest)) { const ext = path.extname(s.file); dest = path.join(dir, `${path.basename(s.file, ext)} (${k++})${ext}`); }
    fs.renameSync(from, dest);
    // keep links in notes pointing at the new place
    const oldRel = `attachments/inbox/${s.file}`; const newRel = path.relative(vault, dest).split(path.sep).join('/');
    for (const n of store.list('note')) if (String(n.body).includes(oldRel)) store.update(n.id, { body: String(n.body).split(oldRel).join(newRel) });
    summary = `Moved ${s.file} to ${newRel}`; s.movedTo = newRel;
  }
  const state = loadState(vault); state.applied.push({ id: s.id, kind: s.kind, at: new Date().toISOString(), by, summary }); saveState(vault, state);
  store.log({ agent: by, action: 'organize.apply', summary: `Tidy-up: ${summary}`, ref: s.ref });
  return { ...s, summary };
}

function dismiss(vault, id) { const s = loadState(vault); if (!s.dismissed.includes(id)) s.dismissed.push(id); saveState(vault, s); return { ok: true }; }

/** Apply every suggestion of the kinds the user allowed to run on their own. */
function autoRun(store, kinds = [], { by = 'cortex (auto tidy-up)' } = {}) {
  const allowed = (kinds || []).filter((k) => SAFE_AUTO.includes(k)); if (!allowed.length) return [];
  const done = [];
  for (const s of suggest(store, { limit: 100000 }).filter((x) => allowed.includes(x.kind)).slice(0, 25)) { try { done.push(apply(store, s.id, { by })); } catch { /* changed meanwhile */ } }
  return done;
}

module.exports = { suggest, apply, dismiss, autoRun, KINDS, SAFE_AUTO, history: (vault) => loadState(vault).applied.slice(-50).reverse() };
