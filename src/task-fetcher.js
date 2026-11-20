'use strict';
// Fetcher per task: each task has a Fetcher switch (on by default), agents get free advice on whether a Fetcher
// request is worth it for their task, and requests made for a task show up on that task for the user to approve.

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function enabled(task) { return !task || String(task.meta.fetcher || 'on') !== 'off'; }

function fetcherFor(store) { const { Fetcher } = require('./fetcher'); return new Fetcher({ store, runner: null }); }

/** Fetcher jobs requested for this task (newest first). */
function requests(store, taskId) {
  return fetcherFor(store).list().filter((j) => j.task === taskId);
}

const POS = [
  [/\b(best|better|faster|quicker|efficient|efficiency|optimi[sz]e|improve|speed up)\b/i, 'asks for a better or faster way'],
  [/\b(learn|research|how (to|do|should)|technique|best practice|workflow|strategy|approach)\b/i, 'is about learning how to do something well'],
  [/\b(new to|first time|unfamiliar|never (used|done)|figure out|not sure how)\b/i, 'involves something new or unfamiliar'],
  [/\b(design|architecture|monetiz\w*|retention|ux|ui|performance|scal\w*|security|testing strategy)\b/i, 'is a craft where proven techniques matter'],
];
const STUCK = /\b(failed|fails|failing|stuck|keeps? (breaking|failing)|didn'?t work|doesn'?t work|tried everything|no luck)\b/i;

// Generic request words that say nothing about the topic itself.
const COVER_STOP = new Set('what changed such way ways our find more best use top improve research proven first new old make how get help need want why when which does doing done thing things work works'.split(' '));
/**
 * Free check: does Cortex memory already cover this topic? Compares the topic's key words with each knowledge note
 * of the project (and system notes); agent journals and the Fetcher's own lessons are left out.
 * → [{ id, title, coverage }] for notes holding ≥ 65% of the key words (best first). Train AI round 4: research the
 *   user's notes already answered cost money and produced nothing.
 */
function coverage(store, text, project, min = 0.65) {
  const { tokenize } = require('./store');
  const qt = [...new Set(tokenize(text).filter((w) => w.length > 2 && !COVER_STOP.has(w)))];
  if (qt.length < 3) return [];
  const f = project ? { kind: 'note', limit: 8, scope: 'project+system', projectScope: project } : { kind: 'note', limit: 8 };
  return store.search(text, f)
    .filter((h) => !h.rec.meta.agent_journal && !h.rec.meta.fetcher_lesson && !/^lesson:/i.test(h.rec.title))
    .map((h) => { const nt = new Set(tokenize(`${h.rec.title} ${h.rec.body}`)); return { id: h.rec.id, title: h.rec.title, coverage: +(qt.filter((t) => nt.has(t)).length / qt.length).toFixed(2) }; })
    .filter((c) => c.coverage >= min)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, 3);
}
const TRIVIAL = /\b(typo|rename|bump|delete|remove|move|cleanup|clean up|fix (a |the )?link|readme|changelog|version number|format(ting)?)\b/i;

/**
 * Free (no AI) advice: is a Fetcher request a good idea for this task?
 * → { enabled, recommend, score, reasons[], lessons[], pending, approved }
 */
function advice(store, task) {
  const t = typeof task === 'string' ? store.must(task) : task;
  const text = `${t.title}\n${t.body || ''}`;
  const reqs = requests(store, t.id);
  const pending = reqs.filter((j) => j.status === 'needs-approval');
  const active = reqs.filter((j) => !['needs-approval', 'rejected', 'error', 'stopped'].includes(j.status));
  const out = { enabled: enabled(t), recommend: false, score: 0, reasons: [], lessons: [], pending: pending.length, approved: active.length };
  if (!out.enabled) { out.reasons.push('Fetcher is turned off for this task by the user. Do not request it.'); return out; }
  let score = 0;
  for (const [re, why] of POS) if (re.test(text)) { score += 1; out.reasons.push(`+ The task ${why}.`); }
  if (t.meta.status === 'blocked' || STUCK.test(text)) { score += 2; out.reasons.push('+ Earlier attempts failed or the task is blocked: outside know-how may unblock it.'); }
  if (String(t.body || '').length > 400) { score += 1; out.reasons.push('+ It is a substantial task (long description).'); }
  if (TRIVIAL.test(t.title)) { score -= 2; out.reasons.push('− It looks like a small mechanical change: research would cost more than it saves.'); }
  if (!String(t.body || '').trim() && t.title.split(/\s+/).length < 5) { score -= 1; out.reasons.push('− There is too little detail to research well.'); }
  try {
    out.lessons = require('./lesson-select').select(store, { project: t.meta.project, text, max: 3, minScore: 2 });
    if (out.lessons.length >= 2) { score -= 2; out.reasons.push(`− ${out.lessons.length} vetted lessons already fit: read those first.`); }
  } catch { /* optional */ }
  try {
    out.covered = coverage(store, text, t.meta.project);
    if (out.covered.length) { score -= 2; out.reasons.push(`− Cortex memory already covers most of this: "${out.covered[0].title}" holds ${Math.round(out.covered[0].coverage * 100)}% of the topic's key words. Read it first and research only what is missing.`); }
  } catch { /* optional */ }
  if (pending.length) { score -= 3; out.reasons.unshift('− A request for this task is already waiting for the user\'s OK.'); }
  if (active.length) { score -= 2; out.reasons.unshift('− Fetcher already ran (or is running) for this task: check fetcher_status first.'); }
  out.score = score;
  out.recommend = score >= 2 && !pending.length && !active.length; // never a duplicate request
  if (!out.reasons.length) out.reasons.push('No strong signal either way.');
  return out;
}

/** Lines for the agent brief. */
function briefLines(store, task) {
  const a = advice(store, task);
  const reqs = requests(store, task.id).slice(0, 5);
  const lines = [`Fetcher for this task: ${a.enabled ? 'ON (you may request research; the user approves it first)' : 'OFF (do not request it)'}.`];
  if (a.enabled) {
    lines.push(`Cortex's free check says: ${a.recommend ? 'a Fetcher request is LIKELY WORTH IT' : 'a Fetcher request is probably NOT worth it'} (score ${a.score}).`, ...a.reasons.map((r) => `  ${r}`));
    lines.push('Decide for yourself: request it only if a proven technique would save more effort than the research costs (it uses some AI). If you do, call `fetcher_request` with this task\'s id as `task`, a specific topic and why. Then carry on; the request shows up on this task for the user.');
  }
  for (const j of reqs) lines.push(`- Request "${clip(j.topic, 80)}" (${j.id}): ${j.status}${j.lesson ? `, lesson ${j.lesson.id || j.lesson}` : ''}`);
  return lines;
}

/** Note a request event on the task itself, so the user sees it there. */
function noteOnTask(store, taskId, text) {
  try { if (store.get(taskId)) store.update(taskId, { append: `**${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Fetcher:** ${text}` }); } catch { /* task may be gone */ }
}

module.exports = { enabled, requests, advice, briefLines, noteOnTask, coverage };
