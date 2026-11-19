'use strict';
// Mind: a queue of things for the AI — videos to watch, articles to read, articles to write.
// Each item is a Markdown file in <vault>/mind/. The body holds "## Summary" (or "## Draft" for
// write items) on top, followed by fetched source material (description + transcript / article text).
const media = require('./media');

const SECTION_LABEL = { watch: 'Watch', read: 'Read', write: 'Write' };

function guessSection(url) {
  if (!url) return 'write';
  if (media.youtubeId(url)) return 'watch';
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/(vimeo|tiktok|twitch|dailymotion|rumble|loom|instagram|x|twitter|facebook|bilibili|odysee|kick)\.(com|tv|be)$/.test(h) || /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url)) return 'watch';
  } catch { /* ignore */ }
  return 'read';
}

function splitBody(body) {
  const b = String(body || '');
  const m = b.match(/^## (Summary|Draft)\n([\s\S]*?)(?=\n## |\n---\n|$)/m);
  const top = m ? m[0] : '';
  const rest = m ? (b.slice(0, m.index) + b.slice(m.index + m[0].length)).replace(/^\s*(---\s*)?/, '') : b;
  return { top: top.trim(), rest: rest.trim() };
}

function add(store, { url, title, section, notes, project, tags, added_by }) {
  url = url ? String(url).trim() : '';
  if (url) { try { new URL(url); } catch { throw new Error('That does not look like a link'); } }
  section = section || guessSection(url);
  if (section !== 'write' && !url) throw new Error('A link is required for Watch and Read items');
  if (section === 'write' && !title) throw new Error('Give the article you want written a title or topic');
  const dupe = url && store.list('mind').find((r) => r.meta.url === url);
  if (dupe) return { rec: dupe, duplicate: true };
  const rec = store.create('mind', {
    title: title || (url ? url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80) : 'Untitled'),
    section, url: url || undefined, notes, project, tags, added_by, status: 'queued',
  });
  return { rec, duplicate: false };
}

async function fetchItem(store, ref) {
  const rec = store.must(ref);
  if (rec.kind !== 'mind') throw new Error('Not a Mind item');
  if (rec.meta.section === 'write') throw new Error('Write items have nothing to fetch');
  if (!rec.meta.url) throw new Error('This item has no link');
  let md;
  let patch;
  try {
    if (rec.meta.section === 'watch') {
      const v = await media.fetchVideo(rec.meta.url);
      md = media.videoMarkdown(v);
      patch = { channel: v.channel || undefined, duration: v.duration || undefined, has_transcript: !!v.transcript, fetch_note: v.note || null };
      if (v.title) patch.title = v.title;
    } else {
      const a = await media.fetchArticle(rec.meta.url);
      md = media.articleMarkdown(a);
      patch = { author: a.author || undefined, site: a.site || undefined, fetch_note: null };
      if (a.title) patch.title = a.title;
    }
  } catch (e) {
    store.update(rec.id, { status: 'failed', fetch_note: e.message });
    throw e;
  }
  const { top } = splitBody(rec.body);
  const keepStatus = rec.meta.status === 'done' ? 'done' : 'fetched';
  return store.update(rec.id, { ...patch, status: keepStatus, fetched: new Date().toISOString(), body: (top ? top + '\n\n---\n\n' : '') + md });
}

/** Save the AI's summary (watch/read) or draft (write). Optionally also store it as a memory note. */
function complete(store, ref, { summary, draft, save_memory = true, tags, agent }) {
  const rec = store.must(ref);
  if (rec.kind !== 'mind') throw new Error('Not a Mind item');
  const isWrite = rec.meta.section === 'write';
  const text = String((isWrite ? draft || summary : summary || draft) || '').trim();
  if (!text) throw new Error(isWrite ? 'draft is required' : 'summary is required');
  const { rest } = splitBody(rec.body);
  const head = `## ${isWrite ? 'Draft' : 'Summary'}\n\n${text}`;
  const out = { item: null, memory: null };
  const patch = { status: 'done', processed_by: agent, processed: new Date().toISOString(), body: head + (rest ? '\n\n---\n\n' + rest : '') };
  if (tags) patch.tags = tags;
  out.item = store.update(rec.id, patch);
  if (save_memory && !isWrite) {
    const title = `${rec.meta.section === 'watch' ? 'Video' : 'Article'}: ${out.item.title}`.slice(0, 120);
    const existing = store.list('note').find((n) => n.meta.mind_item === rec.id);
    const body = `# ${title}\n\n${text}\n\nSource: [[${rec.id}|${out.item.title}]]${rec.meta.url ? ` · ${rec.meta.url}` : ''}`;
    out.memory = existing
      ? store.update(existing.id, { body, updated_by: agent })
      : store.create('note', { title, type: 'reference', body, tags: tags || ['mind', rec.meta.section === 'watch' ? 'video' : 'article'], project: rec.meta.project, mind_item: rec.id, agent });
    store.update(rec.id, { memory: out.memory.id });
  }
  return out;
}

module.exports = { add, fetchItem, complete, guessSection, splitBody, SECTION_LABEL };
