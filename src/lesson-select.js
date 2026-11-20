'use strict';
// Serve Fetcher lessons like Skills (progressive disclosure): an agent sees only the few techniques that fit
// its task — one line each, with the lesson id to read in full — instead of every lesson in the vault.
// Free (no AI): term overlap ranking + hard dedupe across lessons.

const STOP = new Set('a an and are as at be by can do for from how i in into is it its make my of on or so that the this to use using we what when with you your will should into about after before more most than then them they these those our out over up via vs was were which who why'.split(' '));
const stem = (w) => w.replace(/(ingly|edly|ing|ed|ies|es|s|ly)$/, (m) => (m === 'ies' ? 'y' : '')).replace(/(.)\1$/, '$1').replace(/(?<=..[^e])e$/, '');
const terms = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) || [])].filter((w) => !STOP.has(w) && w.length > 2).map(stem);
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return A.size + B.size ? i / (A.size + B.size - i) : 0; };

function lessonsIn(store, project) {
  const notes = project ? [...store.list('note', { project }), ...store.list('note', { scope: 'system' })] : store.list('note', { scope: 'system' });
  return notes.filter((r) => r.meta.fetcher_lesson);
}

/**
 * Pick the techniques that fit `text` (a task or prompt). → [{ lesson, title, name, line, score }]
 * At most `max` (default 5), at most 3 from one lesson, near-duplicates dropped, quarantined ones never included.
 */
function select(store, { project, text, max = 5, minScore = 1 } = {}) {
  const want = terms(text);
  if (!want.length) return [];
  const W = new Set(want);
  const cands = [];
  for (const rec of lessonsIn(store, project)) {
    let techs = [];
    try { techs = JSON.parse(rec.meta.fetcher_lesson || '[]'); } catch { continue; }
    const topic = terms(rec.title.replace(/^Lesson:\s*/i, ''));
    const topicHit = topic.filter((w) => W.has(w)).length;
    for (const t of techs) {
      if (t.safety === 'quarantine') continue;
      const own = terms([t.name, t.when, t.do].join(' '));
      const hit = own.filter((w) => W.has(w)).length;
      const score = hit * 2 + topicHit + (t.trust === 'high' ? 1 : t.trust === 'low' ? -0.5 : 0) + Math.min(2, (t.sources || []).length - 1) * 0.5;
      if (hit + topicHit >= minScore) cands.push({ rec, t, own, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  const perLesson = {};
  for (const c of cands) {
    if (out.length >= max) break;
    if ((perLesson[c.rec.id] || 0) >= 3) continue;
    if (out.some((o) => jaccard(o.own, c.own) >= 0.5 || jaccard(terms(o.name), terms(c.t.name)) >= 0.6)) continue; // hard dedupe
    perLesson[c.rec.id] = (perLesson[c.rec.id] || 0) + 1;
    const line = require('./fetcher').takeaways([c.t], 1)[0];
    out.push({ lesson: c.rec.id, title: c.rec.title, name: c.t.name, line, score: c.score, own: c.own });
  }
  return out.map(({ own, ...o }) => o);
}

/** Markdown lines for a brief / prompt hook. Empty when nothing fits. */
function briefLines(picks) {
  if (!picks.length) return [];
  return [...picks.map((p) => `- ${p.line} (from ${p.lesson})`), '', 'Use these only if they fit. Read the full lesson with memory_get when you use one, say which technique you used, and report back with lesson_feedback if that tool is available.'];
}

module.exports = { select, briefLines, terms };
