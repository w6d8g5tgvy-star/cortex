'use strict';
// Optional "search by meaning" using a local Ollama embedding model (nothing leaves your computer).
// If Ollama isn't running, Cortex quietly uses keyword search only.
// Cache: <vault>/.cortex/embeddings.json  { model, items: { id: { u: updated, v: [..] } } }
const fs = require('fs');
const path = require('path');

const HOST = process.env.CORTEX_OLLAMA || 'http://127.0.0.1:11434';
const cacheFile = (vault) => path.join(vault, '.cortex', 'embeddings.json');

async function status(model) {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { available: false, reason: 'Ollama is not answering' };
    const tags = await r.json();
    const has = (tags.models || []).some((m) => String(m.name).split(':')[0] === model.split(':')[0]);
    return has ? { available: true } : { available: false, reason: `Ollama is running but the "${model}" model is missing. Run: ollama pull ${model}` };
  } catch { return { available: false, reason: 'Ollama is not installed or not running (optional)' }; }
}

async function embed(model, input) {
  const r = await fetch(`${HOST}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Ollama embed failed: HTTP ${r.status}`);
  return (await r.json()).embeddings;
}

function load(vault, model) {
  try { const c = JSON.parse(fs.readFileSync(cacheFile(vault), 'utf8')); if (c.model === model) return c; } catch { /* rebuild */ }
  return { model, items: {} };
}

const textOf = (r) => `${r.title}\n${(r.allTags || []).join(' ')}\n${String(r.body).slice(0, 2400)}`;

/** Embed anything new or changed. Returns how many items were (re)embedded. */
async function index(store, model) {
  const cache = load(store.vault, model);
  const items = [...store.items.values()].filter((r) => ['note', 'mind', 'task', 'project'].includes(r.kind) && !r.meta.agent_journal);
  const todo = items.filter((r) => !cache.items[r.id] || cache.items[r.id].u !== r.updated);
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16);
    const vecs = await embed(model, batch.map(textOf));
    batch.forEach((r, k) => { cache.items[r.id] = { u: r.updated, v: vecs[k].map((x) => Math.round(x * 1e4) / 1e4) }; });
  }
  for (const id of Object.keys(cache.items)) if (!store.items.has(id)) delete cache.items[id];
  fs.writeFileSync(cacheFile(store.vault), JSON.stringify(cache));
  return todo.length;
}

const cos = (a, b) => { let d = 0; let x = 0; let y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

/** Hybrid search: keyword (BM25) + meaning. Falls back to keyword results if Ollama is unavailable. */
async function hybrid(store, q, f, model) {
  const kw = store.search(q, { ...f, limit: 40 });
  let cache;
  try { cache = load(store.vault, model); } catch { return kw.slice(0, f.limit || 20); }
  if (!Object.keys(cache.items).length) return kw.slice(0, f.limit || 20);
  let qv;
  try { [qv] = await embed(model, [q]); } catch { return kw.slice(0, f.limit || 20); }
  const pf = { ...f, limit: undefined }; // limit caps results, not the allowed candidates
  const allowed = new Set((f.kind ? store.list(f.kind, pf) : [...store.list('note', pf), ...store.list('mind', pf), ...store.list('task', pf), ...store.list('project', pf)]).map((r) => r.id));
  const sem = Object.entries(cache.items).filter(([id]) => allowed.has(id)).map(([id, e]) => ({ id, s: cos(qv, e.v) })).sort((a, b) => b.s - a.s).slice(0, 40);
  const maxKw = kw[0] ? kw[0].score : 1;
  const merged = new Map();
  for (const h of kw) merged.set(h.rec.id, { ...h, score: (h.score / maxKw) * 0.55 });
  for (const s of sem) {
    if (s.s < 0.35) continue;
    const rec = store.items.get(s.id);
    if (!rec) continue;
    const prev = merged.get(s.id);
    const add = s.s * 0.6;
    merged.set(s.id, prev ? { ...prev, score: prev.score + add, semantic: true } : { rec, score: add, semantic: true, snippet: String(rec.body).replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, 160) });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).map((h) => ({ ...h, score: Math.round(h.score * 100) })).slice(0, f.limit || 20);
}

module.exports = { status, index, hybrid };
