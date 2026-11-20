'use strict';
// Fetcher: AI agents look through YouTube to learn how to do things better.
//
//   request (plain words) → AI search planner (goal, ideas, vocabulary, 6-10 searches, must-have/avoid)
//   → YouTube searches with real filters (date, length, sort) + your own searches → rank fusion across searches
//   → related-video discovery from the best results → light read of the pool (cleaned, corrected speech, chapters)
//   → free local pre-check with the planner's vocabulary → full read of the shortlist (top comments, linked pages,
//   screen frames) → usefulness checker (AI reviewers see all of it, frames included) → worth-it score (fixed formula)
//   → optional deep round (follow-up searches for what's missing) → lesson memory (capped, merged) → recall self-check.
//
// Requests come from the user (Fetcher tab, phone) or from agents (MCP fetcher_request). Agent requests wait for the
// user's approval unless settings.fetcher.autoRunAgentRequests is on. Full reports: <vault>/fetcher/*.md (not memories).
// Research behind the design: query expansion (keep the original question for judging), rank fusion, conservative
// caption cleanup, glossary-based term correction, keyframes + transcript, per-criterion judging, curated memory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const media = require('./media');
const reader = require('./reader');
const sessions = require('./sessions');
const settingsMod = require('./settings');
const { codexDefaultModel } = require('./models');

const STOP = new Set('the a an and or of to in on for with how what why is are do does did i my your you it its this that be can best way ways use using vs from at by as into about get make more less than so if not no yes all any just like will want need help find me some videos video youtube'.split(' '));
const terms = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.\-]+/g) || [])].filter((t) => !STOP.has(t) && t.length > 1);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOWTO = /\b(step|first|then|next|you can|you should|make sure|instead of|command|run|set up|setup|configure|install|use|tip|trick|workflow|prompt|template|faster|automate|shortcut|example|mistake|avoid)\b/gi;
const vocabOf = (x) => (Array.isArray(x) ? x : terms(x));

// ---------- usage levels: how much a run may spend ----------
// Each level sets how many videos get AI review, how deep the search goes, the reviewer model, what is read
// (screen frames are the costliest extra), how many reviewers work at once, and a hard spending limit for the run.
// Costs are Claude's own figures (API-equivalent dollars; on a subscription they track how much of your limit is used).
const USAGE = {
  low: { label: 'Low', depth: 'quick', maxVideos: 2, model: 'haiku', team: 1, frames: false, maxFrames: 0, framesFor: 0, skim: false, comments: true, links: false, budget: 0.05, estimate: 'about 2-5¢', perVideo: 0.01, excerpt: 4500 },
  medium: { label: 'Medium', depth: 'normal', maxVideos: 3, model: 'sonnet', team: 2, frames: true, maxFrames: 4, framesFor: 2, skim: true, comments: true, links: true, budget: 0.25, estimate: 'about 10-20¢', perVideo: 0.05, excerpt: 6500 },
  high: { label: 'High', depth: 'deep', maxVideos: 6, model: 'sonnet', team: 3, frames: true, maxFrames: 6, framesFor: 12, skim: true, comments: true, links: true, budget: 1.0, estimate: 'about 40-80¢', perVideo: 0.06, excerpt: 9000 },
};
const FETCHER_PROJECT = 'fetcher'; // Fetcher's own runs, cards and activity are filed under this Cortex project
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const nextMidnight = () => { const d = new Date(); d.setHours(24, 0, 5, 0); return d.toISOString(); };

// ---------- depth presets ----------
const DEPTH = {
  quick: { queries: 3, perQuery: 10, related: 0, pool: (n) => Math.min(10, n * 2), round2: false },
  normal: { queries: 6, perQuery: 15, related: 3, pool: (n) => Math.min(16, n * 2 + 2), round2: false },
  deep: { queries: 10, perQuery: 20, related: 5, pool: (n) => Math.min(24, n * 3), round2: true },
};

// ---------- queries & search ----------
function buildQueries(topic, extra = []) {
  const t = String(topic || '').trim();
  return [...new Set([...extra.map(String), t, `${t} tutorial`, `${t} best practices`, `${t} tips workflow`].map((s) => s.trim()).filter(Boolean))].slice(0, 5);
}

// YouTube's search filters are a small protobuf in the "sp" parameter: sort (field 1) and a filter message
// (field 2: upload date = 1, type = 2 (video = 1), duration = 3).
const UPLOAD = { hour: 1, today: 2, week: 3, month: 4, year: 5 };
const LENGTH = { short: 1, long: 2, medium: 3 }; // short < 4 min, medium 4-20 min, long > 20 min
const SORT = { relevance: 0, rating: 1, date: 2, views: 3 };
function encodeSp({ sort = 'relevance', upload = 'any', length = 'any' } = {}) {
  const inner = [];
  if (UPLOAD[upload]) inner.push(0x08, UPLOAD[upload]);
  inner.push(0x10, 0x01);
  if (LENGTH[length]) inner.push(0x18, LENGTH[length]);
  const bytes = [];
  if (SORT[sort]) bytes.push(0x08, SORT[sort]);
  bytes.push(0x12, inner.length, ...inner);
  return Buffer.from(bytes).toString('base64');
}

const parseDuration = (s) => { if (!s) return undefined; const p = String(s).split(':').map(Number); return p.some(isNaN) ? undefined : p.reduce((a, b) => a * 60 + b, 0); };
const parseViews = (s) => { const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i); if (!m) return undefined; return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || '').toUpperCase()] || 1)); };
const parseAge = (s) => { const m = String(s || '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i); if (!m) return undefined; return Number(m[1]) * ({ second: 0, minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()]); };
const text = (x) => (x ? x.simpleText || x.content || (x.runs || []).map((r) => r.text).join('') : '');

/** Video results from a YouTube search results page (ytInitialData). */
function parseSearchPage(html) {
  const data = media.extractJsonAfter(html, 'ytInitialData');
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      out.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText || v.longBylineText), duration: parseDuration(text(v.lengthText)), views: parseViews(text(v.viewCountText)), ageDays: parseAge(text(v.publishedTimeText)), snippet: (v.detailedMetadataSnippets || []).map((d) => text(d.snippetText)).join(' ') || text(v.descriptionSnippet) });
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(data);
  return out;
}

/** "Related videos" from a watch page: YouTube's lockup cards (newer) or compact renderers (older). */
function parseRelated(html) {
  const data = media.extractJsonAfter(html, 'ytInitialData');
  const out = [];
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 80) return;
    if (o.lockupViewModel && o.lockupViewModel.contentId) {
      const lv = o.lockupViewModel;
      if (!lv.contentType || /VIDEO/.test(lv.contentType)) {
        const md = ((lv.metadata || {}).lockupMetadataViewModel) || {};
        const parts = (((md.metadata || {}).contentMetadataViewModel || {}).metadataRows || []).flatMap((r) => (r.metadataParts || []).map((p) => text(p.text))).filter(Boolean);
        const dur = (JSON.stringify(lv.contentImage || {}).match(/"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/) || [])[1];
        if (/^[\w-]{11}$/.test(lv.contentId) && !seen.has(lv.contentId)) {
          seen.add(lv.contentId);
          out.push({ id: lv.contentId, title: text(md.title), channel: parts[0], views: parseViews(parts.find((p) => /view/i.test(p))), ageDays: parseAge(parts.find((p) => /ago/i.test(p))), duration: parseDuration(dur) });
        }
      }
      return;
    }
    if (o.compactVideoRenderer && o.compactVideoRenderer.videoId) {
      const v = o.compactVideoRenderer;
      if (!seen.has(v.videoId)) { seen.add(v.videoId); out.push({ id: v.videoId, title: text(v.title), channel: text(v.longBylineText), duration: parseDuration(text(v.lengthText)), views: parseViews(text(v.viewCountText)), ageDays: parseAge(text(v.publishedTimeText)) }); }
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(data, 0);
  return out.filter((v) => v.title);
}

const run = (bin, args, timeout) => new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: media.toolEnv() }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').pop())) : resolve(out))));
const YT_HEADERS = { Cookie: 'CONSENT=YES+1; SOCS=CAI' };

// The public results page is fast (<1 s) and needs no key; yt-dlp search (~30 s) is the fallback.
async function searchYouTube(query, n = 10, filters = {}) {
  try {
    const page = await media.safeFetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=${encodeURIComponent(encodeSp(filters))}`, { headers: YT_HEADERS });
    const list = parseSearchPage(page.text).slice(0, n);
    if (list.length) return list;
  } catch { /* try yt-dlp */ }
  const bin = process.env.CORTEX_YTDLP || await media.which('yt-dlp');
  if (!bin) throw new Error('YouTube search returned nothing (and yt-dlp is not installed)');
  const j = JSON.parse(await run(bin, ['--flat-playlist', '-J', '--no-warnings', `ytsearch${n}:${query}`], 90000));
  return (j.entries || []).filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title, channel: e.channel || e.uploader, duration: e.duration || undefined, views: e.view_count || undefined, snippet: e.description || '' }));
}

async function relatedVideos(id) {
  const page = await media.safeFetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: YT_HEADERS });
  return parseRelated(page.text);
}

// ---------- matching with the research vocabulary ----------
const hasTerm = (low, v) => (/\s/.test(v) ? low.includes(v) : new RegExp(`\\b${reEsc(v)}`).test(low));
function relevance(textIn, vocab) {
  const low = String(textIn || '').toLowerCase();
  const vs = vocabOf(vocab).map((v) => String(v).toLowerCase());
  if (!vs.length) return 0;
  return Math.min(1, vs.filter((v) => hasTerm(low, v)).length / Math.min(vs.length, 8));
}

/** Rank before spending anything: relevance to the research vocabulary, agreement across searches, views, length, age. */
function rankCandidates(list, vocab) {
  const seen = new Set();
  const maxF = Math.max(0.0001, ...list.map((v) => v.fusion || 0));
  return list.filter((v) => v && v.id && !seen.has(v.id) && seen.add(v.id)).map((v) => {
    const rel = relevance(`${v.title} ${v.snippet || ''}`, vocab);
    const fusion = v.fusion ? v.fusion / maxF : 0;
    const views = v.views ? Math.min(1, Math.log10(v.views + 1) / 6) : 0.3;
    const d = v.duration || 0;
    const dur = !d ? 0.5 : d < 120 ? 0.1 : d <= 2700 ? 1 : d <= 5400 ? 0.6 : 0.3; // shorts and 2-hour streams rarely teach a technique well
    const age = v.ageDays == null ? 0.6 : v.ageDays < 365 ? 1 : v.ageDays < 1095 ? 0.7 : 0.4;
    return { ...v, rank: Math.round(100 * (0.4 * rel + 0.15 * fusion + 0.15 * views + 0.15 * dur + 0.15 * age)) };
  }).sort((a, b) => b.rank - a.rank);
}

function localFilter(list, o = {}) {
  const inc = (o.includeChannels || []).map((c) => c.toLowerCase()).filter(Boolean);
  const exc = (o.excludeChannels || []).map((c) => c.toLowerCase()).filter(Boolean);
  return list.filter((v) => {
    const ch = String(v.channel || '').toLowerCase();
    if (exc.some((c) => ch.includes(c))) return false;
    if (inc.length && !inc.some((c) => ch.includes(c))) return false;
    if (o.minViews && v.views && v.views < o.minViews) return false;
    return true;
  });
}

// ---------- free local pre-check ----------
function preCheck(v, vocab) {
  const vs = vocabOf(vocab).map((x) => String(x).toLowerCase());
  const tx = String(v.transcript || '');
  const words = tx.split(/\s+/).filter(Boolean).length;
  const metaText = [v.description, ...(v.chapters || []).map((c) => c.title), ...(v.tags || [])].join(' ');
  const meta = relevance(metaText, vs);
  if (words < 40) {
    // No speech to read: the description and chapters still say what the video covers (judged more strictly later).
    const rich = String(v.description || '').length > 400 || (v.chapters || []).length >= 3;
    const score = Math.min(40, Math.round(100 * ((rich ? 0.15 : 0.05) + 0.25 * meta)));
    return { score, words: 0, transcript: false, reason: `No transcript: judged from the description${(v.chapters || []).length ? ' and chapters' : ''} (${Math.round(meta * 100)}% of the vocabulary there)` };
  }
  const low = tx.toLowerCase();
  const hits = vs.map((t) => (/\s/.test(t) ? low.split(t).length - 1 : (low.match(new RegExp(`\\b${reEsc(t)}`, 'g')) || []).length));
  const coverage = vs.length ? hits.filter((h) => h > 0).length / Math.min(vs.length, 8) : 0;
  const cov = Math.min(1, coverage);
  const density = Math.min(1, hits.reduce((a, b) => a + b, 0) / Math.max(1, words / 100) / 3);
  const howto = Math.min(1, (low.match(HOWTO) || []).length / Math.max(1, words / 1000) / 25);
  const len = words < 300 ? 0.3 : 1;
  const score = Math.round(100 * (0.35 * cov + 0.2 * density + 0.25 * howto + 0.1 * len + 0.1 * meta));
  return { score, words, transcript: true, coverage: Math.round(cov * 100), howto: Math.round(howto * 100), reason: `${Math.round(cov * 100)}% of the research vocabulary is spoken; how-to density ${Math.round(howto * 100)}%; ${words} words${(v.chapters || []).length ? `; ${(v.chapters || []).length} chapters` : ''}` };
}

const secsOf = (at) => (typeof at === 'number' ? at : String(at || '').replace(/[^\d:]/g, '').split(':').filter(Boolean).map(Number).reduce((a, b) => a * 60 + b, 0));

/** The most relevant parts of a long transcript, cut at its own timestamped segments. Chapters about the topic count
 *  extra; `moments` (from a skim of the whole video) pull in the parts where usable ideas are, even when they don't use
 *  the request's words; and picks are spread across the video so one long section can't take the whole budget. */
function excerpt(tx, vocab, max = 7000, chapters = [], moments = []) {
  tx = String(tx || '');
  if (tx.length <= max) return tx;
  const size = 900;
  const segs = tx.split(/\n\s*\n|(?=\[\d{1,3}:\d{2}(?::\d{2})?\])/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const s of segs) {
    if (cur && cur.length + s.length + 1 > size) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  const vs = vocabOf(vocab).map((x) => String(x).toLowerCase());
  const hotChapters = (chapters || []).map((c, i, a) => ({ from: c.start, to: (a[i + 1] || { start: 1e9 }).start, hot: relevance(c.title, vs) > 0 }));
  const startOf = (t) => { const m = t.match(/^\[(\d{1,3}:\d{2}(?::\d{2})?)\]/); return m ? m[1].split(':').map(Number).reduce((a, b) => a * 60 + b, 0) : null; };
  const starts = chunks.map(startOf);
  const ms = (moments || []).map((m) => ({ t: secsOf(m.at), w: Math.max(1, Math.min(5, Number(m.strength) || 3)) })).filter((m) => m.t || m.t === 0);
  const scored = chunks.map((t, i) => {
    const l = t.toLowerCase();
    const st = starts[i];
    const end = starts.slice(i + 1).find((x) => x != null) ?? 1e9;
    const chap = st != null && hotChapters.some((c) => c.hot && st >= c.from && st < c.to) ? 3 : 0;
    const moment = st != null ? ms.filter((m) => m.t >= st - 5 && m.t < end).reduce((a, m) => a + 4 * m.w, 0) : 0;
    // which part of the video this is: its chapter, or a tenth of the transcript when there are no chapters
    const part = (chapters || []).length && st != null ? Math.max(0, chapters.findIndex((c, k, a) => st >= c.start && st < ((a[k + 1] || {}).start ?? 1e9))) : Math.floor((i / chunks.length) * 10);
    return { i, part, t: t.slice(0, 2 * size), s: vs.reduce((a, w) => a + (l.split(w).length - 1), 0) + 0.5 * (l.match(HOWTO) || []).length + chap + moment };
  });
  const keep = new Set([0]);
  const perPart = new Map([[scored[0].part, 1]]);
  let used = scored[0].t.length;
  const left = scored.slice(1);
  while (left.length) {
    // the best chunk, counting less for each chunk already taken from the same part of the video
    let best = -1; let bestS = -1;
    left.forEach((c, k) => { const eff = c.s / (1 + 0.6 * (perPart.get(c.part) || 0)); if (eff > bestS) { bestS = eff; best = k; } });
    const [c] = left.splice(best, 1);
    if (used + c.t.length > max) continue;
    keep.add(c.i); used += c.t.length + 5; perPart.set(c.part, (perPart.get(c.part) || 0) + 1);
  }
  return scored.filter((c) => keep.has(c.i)).map((c) => c.t).join('\n[…]\n');
}

// ---------- AI search planner ----------
const PLAN_INSTRUCTION = 'You plan YouTube research for an AI agent team (coding and work agents such as Claude Code and Codex). The request on stdin was written by a person in everyday words: it may be vague, emotional, misspelled or describe a symptom instead of naming the topic. Work out what they actually want to learn, then plan searches. Reply with ONLY one JSON object and nothing else:\n'
  + '{"topic":"a short name for this research, 3-7 words, e.g. Stop agents re-reading files","goal":"one sentence: what to learn and why","concepts":["2-6 key ideas"],"vocabulary":["8-20 words and phrases creators actually use for these ideas: jargon, product and tool names, casual phrasing, common misspellings"],"queries":["6-10 YouTube searches from different angles: plain words, expert terms, the problem or symptom as people describe it, specific tools, comparisons (X vs Y), and one with the current year when freshness matters"],"must_have":["1-3 essentials: the core need a useful video must help with (not a checklist of extras)"],"nice_to_have":["extras that make a video better, e.g. measurements, config examples"],"avoid":["what makes a video useless for this request"],"recency":"any|year|month","length":"any|short|medium|long"}\n'
  + 'Keep every search specific to the request; do not drift into neighbouring topics. Prefer searches that find practical, demonstrated techniques.';
const FOLLOWUP_INSTRUCTION = 'You are continuing YouTube research for an AI agent team. Given the goal and what the videos reviewed so far did and did not cover, reply with ONLY one JSON object: {"missing":"one sentence on what is still not covered","queries":["2-4 new, specific YouTube searches aimed at what is missing (not repeats of earlier searches)"]}';

/** The JSON object in an AI reply. Tolerates code fences, prose around it and braces inside strings: every balanced
 *  {...} is tried and the largest one that parses wins. */
function parseJsonObject(reply) {
  const s = String(reply || '').replace(/```(?:json)?/gi, '');
  let best = null; let firstErr = null;
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0; let inStr = false; let esc = false; let end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    if (best && end - start <= best.len) continue;
    try { best = { v: JSON.parse(s.slice(start, end + 1)), len: end - start }; } catch (e) { firstErr = firstErr || e; }
    if (best && start === s.indexOf('{')) break; // the outermost object parsed: done
  }
  if (best) return best.v;
  throw new Error(firstErr ? `The AI's reply was not valid JSON (${firstErr.message})` : 'No JSON in the reply');
}
const strList = (x, n, len) => (Array.isArray(x) ? x : []).map((s) => clip(s, len)).filter(Boolean).slice(0, n);
function parsePlan(reply) {
  const j = parseJsonObject(reply);
  return {
    topic: clip(String(j.topic || '').replace(/^lesson:\s*/i, ''), 70) || undefined, goal: clip(j.goal, 300), concepts: strList(j.concepts, 6, 60), vocabulary: strList(j.vocabulary, 24, 50), queries: strList(j.queries, 10, 100),
    must_have: strList(j.must_have, 3, 160), nice_to_have: strList(j.nice_to_have, 5, 160), avoid: strList(j.avoid, 6, 160),
    recency: ['any', 'year', 'month'].includes(j.recency) ? j.recency : 'any', length: ['any', 'short', 'medium', 'long'].includes(j.length) ? j.length : 'any',
  };
}
function fallbackPlan(job) {
  return { goal: job.topic, concepts: [], vocabulary: [], queries: buildQueries(job.topic), must_have: [], avoid: [], recency: 'any', length: 'any', fallback: true };
}
function planInput(job, store) {
  const p = job.project && store ? store.get('projects/' + job.project) : null;
  return [
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    `Request (the person's own words): ${job.topic}`,
    job.why ? `Why: ${job.why}` : '',
    p ? `Project: ${p.title}${p.meta.description ? ` — ${p.meta.description}` : ''}` : '',
    (job.opts.queries || []).length ? `Searches the person asked for (keep them, add others): ${job.opts.queries.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}
function jobVocab(job) {
  const plan = job.plan || {};
  return [...new Set([...terms(job.topic), ...(plan.concepts || []), ...(plan.vocabulary || [])].map((s) => String(s).toLowerCase().trim()).filter((s) => s.length > 1))].slice(0, 40);
}

// ---------- usefulness checker ----------
const REVIEW_INSTRUCTION = 'You are the Cortex usefulness checker. Review the one YouTube video described on stdin for an AI agent team (coding and work agents such as Claude Code and Codex that work through Cortex, a project manager and long-term memory). Decide what in it would make agents perform tasks better, faster or cheaper, and exactly how an agent would apply it. Be strict: generic advice, hype, outdated tips and things only a human can do score low. Judge substance, not length, enthusiasm or production quality. Use only the material given; never invent techniques that are not in it.\n'
  + 'The transcript is spoken language from captions: speech recognition may mishear technical terms (a list of correct spellings is given), punctuation may be missing, and people speak loosely. Read for what the speaker means. You may also have chapters, the description, pages linked from it, top viewer comments (they can reveal mistakes, outdated steps or better ways; weigh them, do not trust them blindly) and screen frames saved in your current folder (use the Read tool to look at the ones that matter: code, commands, settings and diagrams shown on screen).\n'
  + 'Write each technique as a general rule an agent can follow in ANY project, not a recap of the video: the video\'s own demo details (its sample project, file names, example functions) may appear only as a short "e.g.", never as the rule itself. "when" is the situation that triggers it, written as a phrase that fits after the word "when" (e.g. "a repository has its own test command"). "do" is steps the agent can actually carry out with its normal tools.\n'
  + 'Reply with ONLY one JSON object and nothing else:\n'
  + '{"summary":"two sentences","techniques":[{"name":"short name","when":"the situation in which an agent should use it","do":"concrete steps the agent takes","why":"the expected benefit","evidence":"where it comes from: e.g. 03:12 transcript \\"quote\\", on screen at 02:13: what is shown, comment (19 likes): ..., linked page: ..."}],"applies_to":["task types"],"impact":1,"applicability":1,"confidence":1,"effort":1,"risk":1,"outdated":false,"meets_request":true,"reasoning":"one or two sentences explaining the ratings"}\n'
  + 'Ratings are integers 1-5. impact: how much better agents\' work gets. applicability: how often agents\' tasks hit this. confidence: how sure you are it is correct and current (2 or less without a transcript). effort: cost to adopt (1 easy, 5 hard). risk: chance it causes mistakes or harm (1 low, 5 high). outdated: true if the date, comments or content show it no longer applies. meets_request: true if the video substantially helps with the core need, even if it misses nice-to-haves or covers only part of it; false only if it is mostly about something else or hits a "not useful if" point. At most 4 techniques; an empty list if nothing is useful.';

// ---------- long videos: a cheap skim of the whole transcript, so the checker isn't limited to keyword matches ----------
const SKIM_INSTRUCTION = 'You are skimming one part of a long YouTube video transcript (spoken language from captions; terms may be misheard) for a research goal given on stdin. List the moments in THIS part that contain concrete, usable ideas for the goal: techniques, steps, commands, settings, rules of thumb, warnings, before/after results. Count ideas that serve the goal even when they use different words. Skip intros, sponsors, hype and repetition.\n'
  + 'Reply with ONLY one JSON object: {"moments":[{"at":"m:ss timestamp from the transcript","idea":"the idea in one plain sentence","strength":1}]} with strength 1-5 (5 = concrete and directly useful). At most 5 moments; an empty list if this part has nothing usable.';

/** Split a long transcript into up to `parts` pieces at its own timestamps. */
function transcriptParts(tx, parts = 8, minSize = 12000) {
  const segs = String(tx || '').split(/(?=\[\d{1,3}:\d{2}(?::\d{2})?\])/);
  const size = Math.max(minSize, Math.ceil(tx.length / parts));
  const out = []; let cur = '';
  for (const s of segs) { if (cur && cur.length + s.length > size) { out.push(cur); cur = ''; } cur += s; }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Skim every part of a long transcript with the cheap model; returns the moments with usable ideas, strongest first. */
async function skimTranscript(ask, job, v) {
  const plan = job.plan || {};
  const head = [`Research goal: ${plan.goal || job.topic}`, (plan.must_have || []).length ? `Core need: ${plan.must_have.join('; ')}` : '', `Video: ${v.title}`,
    (v.glossary || []).length ? `Correct spellings: ${v.glossary.slice(0, 20).join(', ')}` : ''].filter(Boolean).join('\n');
  const parts = transcriptParts(v.transcript);
  const moments = []; const runs = [];
  await pmap(parts, 2, async (p, i) => {
    const r = await ask(SKIM_INSTRUCTION, `${head}\nPart ${i + 1} of ${parts.length}:\n${p}`);
    runs.push(r);
    const j = parseJsonObject(r.text);
    for (const m of Array.isArray(j.moments) ? j.moments.slice(0, 5) : []) {
      const idea = clip(m && m.idea, 200);
      if (idea && m.at) moments.push({ at: String(m.at).replace(/[^\d:]/g, '').slice(0, 8), idea, strength: rating(m.strength) });
    }
  });
  moments.sort((a, b) => b.strength - a.strength || secsOf(a.at) - secsOf(b.at));
  return { moments: moments.slice(0, 20), runs, parts: parts.length };
}

function reviewInput(job, v) {
  const plan = job.plan || {};
  const n = (x) => (x == null ? '' : Number(x).toLocaleString('en-US'));
  const read = [
    v.transcript ? `transcript from ${v.transcriptSource || 'captions'}${v.speechFixes ? ` (${v.speechFixes} misheard terms already corrected)` : ''}` : 'no transcript',
    (v.chapters || []).length ? `${v.chapters.length} chapters` : '', (v.comments || []).length ? `${v.comments.length} top comments` : '',
    (v.links || []).length ? `${v.links.length} linked pages` : '', (v.frames || []).length ? `${v.frames.length} screen frames` : '',
  ].filter(Boolean).join(' · ');
  return [
    `The person's request (their own words): "${job.topic}"`,
    job.why ? `Why: ${job.why}` : '',
    plan.goal && !plan.fallback ? `Research goal: ${plan.goal}` : '',
    (plan.must_have || []).length ? `Core need (a useful video must help with this): ${plan.must_have.join('; ')}` : '',
    (plan.nice_to_have || []).length ? `Nice to have (better, not required): ${plan.nice_to_have.join('; ')}` : '',
    (plan.avoid || []).length ? `Not useful if: ${plan.avoid.join('; ')}` : '',
    '',
    `VIDEO: ${v.title} — ${v.channel || 'unknown channel'}${v.duration ? ` — ${Math.round(v.duration / 60)} min` : ''}${v.views ? ` — ${n(v.views)} views` : ''}${v.likes ? ` — ${n(v.likes)} likes` : ''}${v.uploaded ? ` — uploaded ${v.uploaded}` : ''} — https://www.youtube.com/watch?v=${v.id}`,
    `How it was read: ${read}`,
    (v.glossary || []).length ? `Correct spellings of names and terms (speech recognition may mishear them): ${v.glossary.slice(0, 30).join(', ')}` : '',
    (v.chapters || []).length ? `Chapters: ${v.chapters.map((c) => `${media.ts(c.start)} ${c.title}`).join('; ')}` : '',
    v.description ? `Description: ${clip(v.description, 900)}` : '',
    ...((v.links || []).length ? ['Pages linked from the description:', ...v.links.map((l) => `- ${l.title || l.url} (${l.url}): ${clip(l.excerpt, 1000)}`)] : []),
    ...((v.comments || []).length ? ['Top viewer comments (likes; creator and pinned marked):', ...v.comments.map((c) => `- [${c.likes}${c.creator ? ', creator' : ''}${c.pinned ? ', pinned' : ''}] ${c.text}`)] : []),
    ...((v.frames || []).length ? ['Screen frames saved in your current folder (look at the ones that matter with the Read tool):', ...v.frames.map((f) => `- ${path.basename(f.file)} at ${f.at}: ${f.why}`)] : []),
    `Local pre-check: ${v.pre.reason}`,
    ...((v.skim || []).length ? [`Usable ideas a skim found across the WHOLE video (the excerpt below includes the parts around them; judge from the transcript, not from this list):`, ...[...v.skim].sort((a, b) => secsOf(a.at) - secsOf(b.at)).map((m) => `- [${m.at}] ${m.idea} (strength ${m.strength})`)] : []),
    '',
    v.pre.transcript ? `Transcript (most relevant parts${v.transcript && v.transcript.length > ((USAGE[job.usageLevel] || {}).excerpt || 7000) ? `, ${Math.round(100 * ((USAGE[job.usageLevel] || {}).excerpt || 7000) / v.transcript.length)}% of the whole` : ''}, timestamps in [m:ss]):\n${excerpt(v.transcript, jobVocab(job), (USAGE[job.usageLevel] || {}).excerpt || 7000, v.chapters, v.skim)}` : 'No transcript was available: judge from the rest, with low confidence.',
  ].filter((x) => x !== '').join('\n');
}

const rating = (x) => Math.max(1, Math.min(5, Math.round(Number(x) || 1)));
/** Pull the JSON object out of the reviewer's reply and make it safe and well-formed. */
function parseReview(reply) {
  const j = parseJsonObject(reply);
  return {
    summary: clip(j.summary, 500),
    techniques: (Array.isArray(j.techniques) ? j.techniques : []).slice(0, 4).filter((t) => t && t.name).map((t) => ({ name: clip(t.name, 80), when: clip(String(t.when || '').replace(/^\s*when\s+/i, ''), 300), do: clip(t.do, 500), why: clip(t.why, 300), evidence: clip(t.evidence, 220) })),
    applies_to: (Array.isArray(j.applies_to) ? j.applies_to : []).slice(0, 6).map((x) => clip(x, 60)),
    impact: rating(j.impact), applicability: rating(j.applicability), confidence: rating(j.confidence), effort: rating(j.effort), risk: rating(j.risk),
    outdated: j.outdated === true, meets_request: j.meets_request !== false,
    reasoning: clip(j.reasoning, 400),
  };
}

/**
 * Worth-it score 0-100, calculated by Cortex (not by the AI) from the reviewer's ratings:
 *   35% impact + 25% applicability + 15% confidence + 15% low effort + 10% low risk   (each rating mapped 1..5 → 0..1)
 * Verdict: ≥ threshold (60) "worth it", ≥ 45 "maybe", else "not worth it". Can't be "worth it" with low confidence (≤ 2),
 * no techniques, outdated content, or when it doesn't give what the request needs.
 */
function worth(r, threshold = 60) {
  const n = (x) => (rating(x) - 1) / 4;
  const score = Math.round(100 * (0.35 * n(r.impact) + 0.25 * n(r.applicability) + 0.15 * n(r.confidence) + 0.15 * (1 - n(r.effort)) + 0.10 * (1 - n(r.risk))));
  let verdict = score >= threshold ? 'worth it' : score >= 45 ? 'maybe' : 'not worth it';
  if (verdict === 'worth it' && (rating(r.confidence) <= 2 || !(r.techniques || []).length || r.outdated || r.meets_request === false)) verdict = 'maybe';
  return { score, verdict };
}

/** Ask Claude Code for a reply. No MCP servers; built-in tools only if given (the reviewer gets Read for frames).
 *  Hooks stay quiet (CORTEX_QUIET) so no Cortex brief is added. Returns the real model used. */
function claudeAsker(runner, model, { tools = '', cwd } = {}) {
  return async (instruction, input, opts = {}) => {
    await runner.available();
    const bin = runner.bin('claude');
    const t = opts.tools !== undefined ? opts.tools : tools;
    const args = ['-p', instruction, '--output-format', 'json', '--tools', t, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(model ? ['--model', model] : [])];
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { cwd: opts.cwd || cwd || os.tmpdir(), env: { ...process.env, CORTEX_QUIET: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error('The AI took longer than 5 minutes')); }, 300000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.stdin.on('error', () => {});
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        let j = null;
        try { j = JSON.parse(out); } catch { /* not json */ }
        if (!j || j.is_error) return reject(new Error(clip((j && j.result) || err || out || `Claude Code exited with ${code}`, 300)));
        const u = j.usage || {};
        const used = Object.keys(j.modelUsage || {}).sort((a, b) => ((j.modelUsage[b].outputTokens || 0) - (j.modelUsage[a].outputTokens || 0)))[0] || j.model || model;
        resolve({ text: j.result, usage: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 }, cost: j.total_cost_usd || 0, model: used });
      });
      p.stdin.end(input);
    });
  };
}

/** Ask Codex instead (`codex exec --json`). Read-only sandbox, no saved session, the user's config (and so
 *  its MCP servers) ignored; sign-in still comes from CODEX_HOME. Screen frames are attached as images.
 *  Runs on the user's ChatGPT plan, so there is no dollar cost to report (tokens are still counted). */
// Codex's model list (`codex debug models`), cached for an hour. Used for the settings picker and so a run
// always names the model it asked for (Codex doesn't report the model it used in `exec --json`).
let codexCatalog = { at: 0, list: [] };
async function codexModels(runner) {
  if (Date.now() - codexCatalog.at < 3600e3 && codexCatalog.list.length) return codexCatalog.list;
  await runner.available();
  const bin = runner.resolved.codex;
  if (!bin) return [];
  const out = await new Promise((res) => execFile(bin, ['debug', 'models'], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) }, (e, o) => res(e ? '' : String(o))));
  let list = [];
  try { list = (JSON.parse(out).models || []).filter((m) => m.visibility === 'list' && m.slug).sort((a, b) => (a.priority || 99) - (b.priority || 99)).map((m) => ({ slug: m.slug, name: m.display_name || m.slug, description: clip(m.description || '', 100) })); } catch { /* old Codex */ }
  codexCatalog = { at: Date.now(), list };
  return list;
}

function codexAsker(runner, model, { cwd } = {}) {
  return async (instruction, input, opts = {}) => {
    await runner.available();
    const bin = runner.bin('codex');
    const dir = opts.cwd || cwd || os.tmpdir();
    const images = opts.cwd ? (() => { try { return fs.readdirSync(opts.cwd).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().slice(0, 8); } catch { return []; } })() : [];
    const used = model || codexDefaultModel() || ((await codexModels(runner))[0] || {}).slug || undefined;
    // No ChatGPT apps, plugins, hooks or project docs: a plain text job (they cost ~70k tokens per call otherwise).
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'skill_search',
      '-c', 'project_doc_max_bytes=0', '-s', 'read-only', '-C', dir,
      ...(used ? ['-m', used] : []), ...images.flatMap((f) => ['-i', path.join(dir, f)]), '-'];
    const prompt = `This is a one-off text task run by Cortex's Fetcher. Skip any standing instructions about Cortex tools, sessions, tasks or logging, and just answer.\n\n${instruction}\n\n${images.length ? `(The screen frames listed below are attached as images, in this order: ${images.join(', ')}. Do not run commands.)\n\n` : 'Do not run commands or open files; everything you need is below.\n\n'}${input}`;
    return new Promise((resolve, reject) => {
      const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
      const p = spawn(win ? `"${bin}"` : bin, win ? args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : args, { cwd: dir, env: { ...process.env, CORTEX_QUIET: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: win });
      let out = ''; let err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error('Codex took longer than 5 minutes')); }, 300000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.stdin.on('error', () => {});
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        let text = ''; let usage = { input: 0, output: 0 }; let failed = '';
        for (const line of out.split(/\r?\n/)) {
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) text = ev.item.text;
          if (ev.type === 'turn.completed' && ev.usage) usage = { input: (ev.usage.input_tokens || 0), output: (ev.usage.output_tokens || 0) };
          if (ev.type === 'turn.failed' || ev.type === 'error') failed = (ev.error && ev.error.message) || ev.message || failed;
        }
        if (!text) return reject(new Error(clip(failed || err || out || `Codex exited with ${code}`, 300)));
        resolve({ text, usage, cost: 0, model: used ? `codex (${used})` : 'codex' });
      });
      p.stdin.end(prompt);
    });
  };
}

// ---------- teaching: lessons agents actually find and use ----------
const normName = (s) => terms(s).sort().join(' ') || String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const lessonTitle = (topic) => clip(`Lesson: ${String(topic).trim()}`, 90);
const REVIEW_VERSION = 3; // bump when the reviewer instructions change, so cached reviews are redone
const MAX_TECHNIQUES = 12; // keep lessons small and sharp; weaker techniques drop off as better ones arrive
const lessonTopic = (job) => (job.plan && job.plan.topic && !job.plan.fallback ? job.plan.topic : job.topic);
function similarTitle(a, b) {
  const A = new Set(terms(String(a).replace(/^Lesson:\s*/i, ''))); const B = new Set(terms(String(b).replace(/^Lesson:\s*/i, '')));
  if (!A.size || !B.size) return 0;
  return [...A].filter((x) => B.has(x)).length / Math.max(A.size, B.size);
}

/** One line per technique, for previews (recall, briefs, excerpts): the advice itself, not the boilerplate. */
/** "When A repository uses…" → "a repository uses…" (keeps acronyms and names like "CLAUDE.md" or "Codex"). */
function whenText(w) {
  const s = String(w || '').trim().replace(/^\s*when\s+/i, '').replace(/[.]\s*$/, '');
  return /^(A|An|The|You|Your|An?other|Any|Some|Each|Every|Agents?|It|There|This|That|Its)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
const fb = (t) => t.feedback || {};
const helpedText = (t) => (fb(t).helped ? `helped ${fb(t).helped}×` : '');

function takeaways(techs, max = 6) {
  return techs.slice(0, max).map((t) => {
    const tags = [(t.sources || []).length >= 2 ? `${t.sources.length} videos agree` : '', helpedText(t)].filter(Boolean).join(', ');
    return `${t.name}${tags ? ` (${tags})` : ''}: ${t.when ? `when ${clip(whenText(t.when), 100)} → ` : ''}${clip(t.do, 150)}`;
  });
}

function lessonBody(topic, techs, stats) {
  const lines = [
    `# ${lessonTitle(topic)}`, '',
    'Key takeaways (apply the ones that match your task):',
    ...takeaways(techs, 10).map((t) => `- ${t}`), '',
    `> Learned by Cortex Fetcher from YouTube (${stats.videos} video${stats.videos === 1 ? '' : 's'} passed the usefulness checker; last run ${stats.date}). Each technique scored "worth it" (≥ ${stats.threshold}/100); the ones with an Example were also tried out on a real task. After you use one, report it with lesson_feedback (lesson, technique, helped / partly / didn't help): techniques that keep not helping are dropped. Ask the user before installing any tool or service a technique names. Reports with every video checked: vault folder fetcher/.`, '',
    '## Techniques in detail', '',
  ];
  for (const t of techs) {
    const f = fb(t);
    lines.push(`### ${t.name}`, `- **When:** ${whenText(t.when) || '—'}`, `- **Do:** ${t.do || '—'}`, `- **Why:** ${t.why || '—'}`,
      ...(t.tryout ? [`- **Example${t.tryout.task ? ` (tried on "${clip(t.tryout.task, 80)}")` : ''}:** ${t.tryout.steps}`] : []),
      ...(f.used ? [`- **Track record:** used ${f.used}× · helped ${f.helped || 0} · partly ${f.partly || 0} · didn't help ${f.failed || 0}${(f.notes || []).length ? ` · latest: "${clip(f.notes[f.notes.length - 1], 120)}"` : ''}`] : []),
      `- **Sources:** ${t.sources.map((s) => `[${clip(s.title, 70)}](${s.url}) (score ${s.score}${s.evidence ? `, ${clip(s.evidence, 60)}` : ''})`).join('; ')}${t.last_confirmed ? ` · last confirmed ${t.last_confirmed}` : ''}`, '');
  }
  return lines.join('\n');
}

// ---------- tryout: before teaching, each technique is applied to one of the user's real tasks ----------
const TRYOUT_INSTRUCTION = 'You are the Cortex tryout step. Candidate techniques learned from YouTube videos are on stdin, with real tasks from the user\'s task board and the techniques agents already know. For EACH candidate, try it out: pick the real task it fits best (or say "a typical task" if none fit) and write the exact steps an agent would take on that task with its normal tools (files, terminal, its own instructions files, Cortex memory). Then decide whether to teach it.\n'
  + 'Drop it (keep=false) if: an agent could not do it without guessing; it is generic advice an agent already follows; it needs a human, a paid service or a tool the user would have to install without saying so; it repeats a technique agents already know; or it only makes sense in the video\'s own demo project.\n'
  + 'Also rewrite every kept technique as a general rule for ANY project: the demo\'s file names, sample functions and project details may appear only as a short "e.g.". "when" is a phrase that fits after the word "when".\n'
  + 'Reply with ONLY one JSON object, one entry for EVERY candidate, in order: {"techniques":[{"index":0,"original":"the candidate\'s name exactly as given","keep":true,"reason":"one sentence","name":"short name","when":"…","do":"concrete steps","why":"expected benefit","task":"the real task you tried it on","steps":"what the agent would do on that task, 1-3 sentences"}]} with one entry per candidate, using its index.';

function tryoutCandidates(job) {
  const out = [];
  for (const v of job.videos.filter((x) => x.review && (x.verdict === 'worth it' || x.taught))) {
    (v.review.techniques || []).forEach((t, k) => out.push({ v, k, t }));
  }
  return out;
}

function tryoutInput(store, job, cands) {
  const p = job.project;
  const tasks = store.list('task', { open: true, ...(p ? { project: p } : {}) }).slice(0, 6).map((r) => `- ${r.title}${r.meta.project ? ` (project ${r.meta.project})` : ''}`);
  // what OTHER lessons already teach (the lesson this run adds to doesn't count: finding its techniques again confirms them)
  const target = lessonTitle(lessonTopic(job));
  const known = store.list('note', {}).filter((r) => r.meta.fetcher_lesson && (!p || !r.meta.project || r.meta.project === p))
    .filter((r) => r.title !== target && r.title !== lessonTitle(job.topic) && similarTitle(r.title, target) < 0.6)
    .flatMap((r) => { try { return JSON.parse(r.meta.fetcher_lesson).map((t) => `- ${t.name}: ${clip(t.do, 100)}`); } catch { return []; } }).slice(0, 25);
  return [
    `Research request: "${job.topic}"${job.plan && job.plan.goal ? ` (goal: ${job.plan.goal})` : ''}`,
    `Real tasks on the user's board${p ? ` in project ${p}` : ''}:`, ...(tasks.length ? tasks : ['- (none open: use a typical coding-agent task)']),
    'Techniques agents already know (from earlier lessons):', ...(known.length ? known : ['- (none yet)']),
    '', 'Candidates:',
    ...cands.map(({ v, t }, i) => `[${i}] ${t.name}\n  when: ${t.when}\n  do: ${t.do}\n  why: ${t.why}\n  from: ${v.title}${t.evidence ? ` (${clip(t.evidence, 160)})` : ''}`),
  ].join('\n');
}

/** Apply the tryout reply: kept techniques get the general wording and a worked example; dropped ones are marked with why. */
function applyTryout(cands, reply) {
  const j = parseJsonObject(reply);
  const rows = Array.isArray(j.techniques) ? j.techniques : [];
  let kept = 0; let dropped = 0;
  const free = (c) => c && !c.t.tryout && !c.t.dropped;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    // match by index, but check the name: a reply that numbers from 1 or skips one must not land on the wrong technique
    let c = cands[Number(row.index)];
    const named = row.original || row.name;
    if (named && (!c || similarTitle(c.t.name, named) < 0.3)) c = cands.find((x) => free(x) && (normName(x.t.name) === normName(named) || similarTitle(x.t.name, named) >= 0.5)) || (c && similarTitle(c.t.name, named) >= 0.3 ? c : null);
    if (!free(c)) continue;
    if (row.keep === false) { c.t.dropped = clip(row.reason, 200) || 'dropped by the tryout'; dropped++; continue; }
    for (const f of ['name', 'when', 'do', 'why']) if (row[f] && String(row[f]).trim()) c.t[f] = clip(row[f], f === 'name' ? 80 : 600);
    c.t.tryout = { task: clip(row.task, 120), steps: clip(row.steps, 400) || 'applied without problems' };
    kept++;
  }
  return { kept, dropped, missing: cands.filter((c) => !c.t.tryout && !c.t.dropped).length };
}

// ---------- feedback: agents report whether a technique helped; ones that keep failing are dropped ----------
const FADE_AFTER = 3; // "didn't help" reports, with no "helped", before a technique is dropped
function recordFeedback(store, { lesson, technique, result, note, agent, model }) {
  const RESULTS = { helped: 'helped', yes: 'helped', partly: 'partly', partial: 'partly', didnt_help: 'failed', "didn't help": 'failed', no: 'failed', failed: 'failed', not_applicable: 'na', na: 'na' };
  const kind = RESULTS[String(result || '').toLowerCase().trim()];
  if (!kind) throw new Error('result must be helped, partly, didnt_help or not_applicable');
  const all = store.list('note', {}).filter((r) => r.meta.fetcher_lesson);
  const q = String(lesson || '').trim();
  const rec = all.find((r) => r.id === q || r.title === q || r.title === lessonTitle(q)) || all.map((r) => ({ r, s: similarTitle(r.title, q) })).sort((a, b) => b.s - a.s).find((x) => x.s >= 0.5)?.r;
  if (!rec) throw new Error(`No lesson matches "${clip(q, 80)}". Lessons: ${all.map((r) => r.title).slice(0, 8).join('; ')}`);
  const techs = JSON.parse(rec.meta.fetcher_lesson);
  const k = normName(technique);
  const t = techs.find((x) => normName(x.name) === k) || techs.map((x) => ({ x, s: similarTitle(x.name, technique) })).sort((a, b) => b.s - a.s).find((y) => y.s >= 0.5)?.x;
  if (!t) throw new Error(`"${rec.title}" has no technique like "${clip(technique, 80)}". Its techniques: ${techs.map((x) => x.name).join('; ')}`);
  const f = t.feedback = t.feedback || { used: 0, helped: 0, partly: 0, failed: 0, notes: [] };
  if (kind !== 'na') f.used++;
  if (kind === 'helped') f.helped++; else if (kind === 'partly') f.partly++; else if (kind === 'failed') f.failed++;
  if (note) f.notes = [...(f.notes || []), `${kind}${agent ? ` (${agent})` : ''}: ${clip(note, 200)}`].slice(-3);
  let faded = null;
  let gone = [];
  try { gone = JSON.parse(rec.meta.fetcher_faded || '[]'); } catch { gone = []; }
  if (f.failed >= FADE_AFTER && !f.helped) { faded = t.name; gone.push({ name: t.name, why: `${f.failed} agents said it didn't help`, date: new Date().toISOString().slice(0, 10) }); techs.splice(techs.indexOf(t), 1); }
  techs.sort((a, b) => techScore(b) - techScore(a));
  const videos = new Set(techs.flatMap((x) => x.sources.map((s) => s.url))).size;
  const date = (rec.body.match(/last run (\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 10);
  const threshold = Number((rec.body.match(/≥ (\d+)\/100/) || [])[1]) || 60;
  store.update(rec.id, { body: lessonBody(rec.title.replace(/^Lesson:\s*/, ''), techs, { videos, date, threshold }), fetcher_lesson: JSON.stringify(techs), fetcher_faded: JSON.stringify(gone.slice(-30)) });
  store.log({ agent: agent || 'agent', model, action: 'lesson.feedback', summary: `${t.name} (${rec.title}): ${kind === 'na' ? 'not applicable' : kind}${faded ? ' → dropped from the lesson' : ''}${note ? ` · ${clip(note, 120)}` : ''}`, project: rec.meta.project, ref: rec.id });
  return { lesson: rec.title, technique: t.name, result: kind, track_record: { used: f.used, helped: f.helped, partly: f.partly, didnt_help: f.failed }, dropped: !!faded };
}
// strongest first: more videos agree, then proven help, then the video's score
function techScore(t) { const f = fb(t); return (t.sources || []).length * 10 + 6 * (f.helped || 0) + 2 * (f.partly || 0) - 5 * (f.failed || 0) + Math.max(0, ...(t.sources || []).map((s) => s.score || 0)) / 10; }

/** Merge this job's worth-it techniques into "Lesson: <topic>": same technique from several videos → one entry with all
 *  sources; strongest first; capped so the lesson stays sharp. */
function teach(store, job) {
  const good = job.videos.filter((v) => v.review && (v.verdict === 'worth it' || v.taught));
  if (!good.length) return null;
  // A clean name from the planner ("Stop agents re-reading files"), not the raw request sentence; an existing lesson
  // with a similar name is extended instead of starting a second one.
  const title = lessonTitle(lessonTopic(job));
  const today = new Date().toISOString().slice(0, 10);
  const lessons = store.list('note', job.project ? { project: job.project } : { scope: 'system' }).filter((r) => r.meta.fetcher_lesson);
  const existing = lessons.find((r) => r.title === title || r.title === lessonTitle(job.topic)) || lessons.find((r) => similarTitle(r.title, title) >= 0.6);
  let techs = [];
  try { techs = existing && existing.meta.fetcher_lesson ? JSON.parse(existing.meta.fetcher_lesson) : []; } catch { techs = []; }
  const byName = new Map(techs.map((t) => [normName(t.name), t]));
  // techniques agents reported as not helping were dropped: don't bring them back
  let faded = [];
  try { faded = JSON.parse((existing && existing.meta.fetcher_faded) || '[]').map((f) => normName(f.name)); } catch { faded = []; }
  let added = 0;
  const touched = new Set();
  for (const v of good) {
    for (const t of v.review.techniques) {
      if (!v.taught && (!t.evidence || /^[-—\s]*$/.test(t.evidence))) continue; // no evidence, not taught (unless you chose to teach it)
      if (t.dropped && !v.taught) continue; // failed the tryout (you can still teach it yourself)
      let k = normName(t.name);
      if (faded.some((f) => f === k || similarTitle(f, k) >= 0.6)) continue;
      if (!byName.has(k)) { const near = [...byName.keys()].find((x) => similarTitle(x, k) >= 0.6); if (near) k = near; }
      const src = { title: v.title, url: `https://www.youtube.com/watch?v=${v.id}`, score: v.score, evidence: t.evidence };
      const cur = byName.get(k);
      touched.add(k);
      added++;
      if (cur) {
        if (!cur.sources.some((s) => s.url === src.url)) { cur.sources.push(src); cur.last_confirmed = today; }
        if ((t.tryout && !cur.tryout) || (!!t.tryout === !!cur.tryout && String(t.do).length > String(cur.do).length)) Object.assign(cur, { when: t.when, do: t.do, why: t.why, ...(t.tryout ? { tryout: t.tryout } : {}) });
      } else byName.set(k, { name: t.name, when: t.when, do: t.do, why: t.why, ...(t.tryout ? { tryout: t.tryout } : {}), sources: [src], last_confirmed: today });
    }
  }
  if (!added && !existing) return null;
  // Re-teaching a run (rescore, tryout redone): entries that came only from this run's videos and weren't produced
  // this time are its own older wording or were dropped since, so they go (track records are kept on the new entry).
  const runUrls = new Set(job.videos.map((v) => `https://www.youtube.com/watch?v=${v.id}`));
  for (const [k, t] of [...byName]) {
    if (touched.has(k) || !(t.sources || []).length || !t.sources.every((s) => runUrls.has(s.url))) continue;
    byName.delete(k);
    if (t.feedback && t.feedback.used) {
      const heir = [...byName.entries()].find(([k2, x]) => touched.has(k2) && x.sources.some((s) => t.sources.some((o) => o.url === s.url)) && similarTitle(x.name, t.name) >= 0.3);
      if (heir && !heir[1].feedback) heir[1].feedback = t.feedback;
    }
  }
  const all = [...byName.values()].sort((a, b) => techScore(b) - techScore(a));
  techs = all.slice(0, MAX_TECHNIQUES);
  const videos = new Set(techs.flatMap((t) => t.sources.map((s) => s.url))).size;
  const lessonName = existing ? existing.title.replace(/^Lesson:\s*/, '') : lessonTopic(job);
  const body = lessonBody(lessonName, techs, { videos, date: today, threshold: job.threshold });
  const meta = { type: 'reference', tags: ['lesson', 'fetcher'], fetcher_lesson: JSON.stringify(techs), agent: 'fetcher', ...(job.models && job.models.reviewer ? { model: job.models.reviewer } : {}) };
  const rec = existing ? store.update(existing.id, { body, ...meta }) : store.create('note', { title, body, ...meta, ...(job.project ? { project: job.project } : {}) });
  return { id: rec.id, title: rec.title, techniques: techs.length, merged: !!existing, dropped: all.length - techs.length };
}

/** Does an agent asking about the topic actually get the lesson? (Same search Cortex's recall uses.) */
function recallCheck(store, job, lessonId) {
  const f = job.project ? { scope: 'project+system', projectScope: job.project } : { scope: 'system' };
  const hits = store.search(job.topic, { kind: 'note', limit: 5, minMatch: 1, ...f }).filter((h) => !h.rec.meta.agent_journal);
  const rank = hits.findIndex((h) => h.rec.id === lessonId);
  return { found: rank >= 0 && rank < 3, rank: rank >= 0 ? rank + 1 : null, query: job.topic };
}

function reportMarkdown(job) {
  const read = (v) => [v.transcriptSource && v.transcriptSource !== 'none' ? v.transcriptSource : 'no transcript', v.comments ? `${v.comments} comments` : '', v.links ? `${v.links} links` : '', v.frames ? `${v.frames} frames` : ''].filter(Boolean).join(', ');
  const row = (v) => `| [${clip(v.title, 60).replace(/\|/g, '/')}](https://www.youtube.com/watch?v=${v.id}) | ${v.via ? 'related' : 'search'} | ${read(v)} | ${v.pre ? v.pre.score : '—'} | ${v.score != null ? v.score : '—'} | ${v.verdict || v.skipped || '—'} | ${clip(v.review ? v.review.reasoning : v.error || (v.pre && v.pre.reason) || '', 140).replace(/\|/g, '/')} |`;
  const plan = job.plan || {};
  return [
    `# Fetcher report: ${job.topic}`, '',
    `- **Requested by:** ${job.from}${job.why ? ` — ${job.why}` : ''}`,
    `- **When:** ${job.created.slice(0, 16).replace('T', ' ')} · **Status:** ${job.status}${job.project ? ` · **Project:** ${job.project}` : ''} · **Depth:** ${(job.opts || {}).depth || 'normal'}`,
    plan.goal ? `- **Understood as:** ${plan.goal}${plan.fallback ? ' (planner unavailable: basic searches used)' : ''}` : '',
    (plan.vocabulary || []).length ? `- **Vocabulary:** ${plan.vocabulary.join(', ')}` : '',
    `- **Searches:** ${(job.searches || job.queries.map((q) => ({ q }))).map((s) => `"${s.q}"${s.by ? ` (${s.by}${s.found != null ? `, ${s.found}` : ''})` : ''}`).join(', ')} → ${job.found || 0} videos found${job.relatedFound ? `, ${job.relatedFound} more via related videos` : ''}, ${job.videos.length} read`,
    `- **Models:** planner ${(job.models || {}).planner || '—'} · usefulness checker ${(job.models || {}).reviewer || job.model || '—'} · ${job.usage.input.toLocaleString()} input / ${job.usage.output.toLocaleString()} output tokens${job.usage.cost ? ` · ${job.usage.cost.toFixed(3)}` : ''} · usage level ${job.usageLevel || 'custom'}${job.budget ? ` (limit ${job.budget.toFixed(2)})` : ''}${job.limitHit ? ` · stopped early: ${job.limitHit}` : ''}`,
    job.tryout ? `- **Tryout on your real tasks:** ${job.tryout.skipped ? `skipped (${job.tryout.skipped}); techniques taught as the checker wrote them` : job.tryout.error ? `failed (${job.tryout.error}); techniques taught as the checker wrote them` : `${job.tryout.kept} kept, ${job.tryout.dropped} dropped${job.tryout.missing ? `, ${job.tryout.missing} not answered` : ''}`}` : '',
    job.videos.some((v) => v.skim && v.skim.moments) ? `- **Long videos skimmed in full:** ${job.videos.filter((v) => v.skim && v.skim.moments).map((v) => `${clip(v.title, 50)} (${v.skim.moments} moments)`).join(', ')}` : '',
    job.lesson ? `- **Taught:** [[${job.lesson.title || lessonTitle(job.topic)}]] (${job.lesson.techniques} techniques${job.lesson.merged ? ', merged with earlier runs' : ''}) · recall check: ${job.learning && job.learning.found ? `found at #${job.learning.rank}` : 'NOT found in the top 3'}` : '- **Taught:** nothing passed the checker',
    '', '| Video | Found by | Read | Pre-check | Worth-it | Verdict | Why |', '|---|---|---|---|---|---|---|', ...job.videos.map(row), '',
    ...job.videos.filter((v) => v.review && v.review.techniques.length).flatMap((v) => [`## ${clip(v.title, 90)} (${v.score}, ${v.verdict})`, '', v.review.summary, '', ...v.review.techniques.map((t) => `- **${t.name}**${t.dropped ? ` — ❌ dropped by the tryout: ${t.dropped}` : t.tryout ? ` — ✓ tried on "${t.tryout.task}"` : ''} — when: ${whenText(t.when)} · do: ${t.do} · why: ${t.why}${t.evidence ? ` · (${t.evidence})` : ''}`), '']),
  ].filter((x) => x !== '').join('\n');
}

// ---------- jobs ----------
const OPT_DEFAULTS = { depth: 'normal', upload: 'auto', length: 'auto', sort: 'relevance', minViews: 0, includeChannels: [], excludeChannels: [], related: true, planner: true, comments: true, links: true, frames: true, queries: [] };
function cleanOpts(o = {}) {
  const list = (x) => (Array.isArray(x) ? x : String(x || '').split(/[\n,]/)).map((s) => clip(s, 100)).filter(Boolean).slice(0, 10);
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  return {
    depth: pick(o.depth, Object.keys(DEPTH), 'normal'),
    upload: pick(o.upload, ['auto', 'any', ...Object.keys(UPLOAD)], 'auto'),
    length: pick(o.length, ['auto', 'any', ...Object.keys(LENGTH)], 'auto'),
    sort: pick(o.sort, Object.keys(SORT), 'relevance'),
    minViews: Math.max(0, Math.min(1e9, Number(o.minViews) || 0)),
    includeChannels: list(o.includeChannels), excludeChannels: list(o.excludeChannels), queries: list(o.queries).slice(0, 5),
    related: o.related !== false, planner: o.planner !== false, comments: o.comments !== false, links: o.links !== false, frames: o.frames !== false,
    team: Math.max(1, Math.min(4, Number(o.team) || 2)), maxFrames: Math.max(0, Math.min(8, o.maxFrames === undefined ? 6 : Number(o.maxFrames) || 0)),
  };
}

/** Fill in a usage level's settings for anything the request didn't set itself. */
function applyUsage(level, req) {
  const p = USAGE[level];
  if (!p) return req; // custom: use exactly what was given
  const pick = (k) => (req[k] === undefined || req[k] === null || req[k] === '' ? p[k] : req[k]);
  return { ...req, depth: pick('depth'), maxVideos: pick('maxVideos'), model: pick('model'), team: pick('team'), frames: pick('frames'), maxFrames: pick('maxFrames'), comments: pick('comments'), links: pick('links') };
}

class Fetcher {
  constructor({ store, runner, broadcast = () => {}, deps = {} }) {
    this.store = store;
    this.vault = store.vault;
    this.runner = runner;
    this.broadcast = broadcast;
    this.deps = deps; // tests: { search, related, read | fetchVideo, ask, planAsk, retryMs }
    this.dir = path.join(this.vault, '.cortex', 'fetcher');
    this.running = new Set();
  }

  conf() { return { maxVideos: 5, team: 3, model: 'sonnet', plannerModel: 'haiku', reviewer: 'claude', codexModel: '', threshold: 60, autoRunAgentRequests: false, usage: 'medium', perRunBudget: 0.25, dailyBudget: 1, ...(settingsMod.load(this.vault).fetcher || {}) }; }

  // Reads and reviews are cached, so re-running a topic (or a similar request) doesn't pay twice for the same video.
  cacheGet(key, days) {
    try { const c = JSON.parse(fs.readFileSync(path.join(this.dir, 'cache', key + '.json'), 'utf8')); return Date.now() - c.at < days * 864e5 ? c.v : null; } catch { return null; }
  }
  cachePut(key, v) {
    try { const d = path.join(this.dir, 'cache'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, key + '.json'), JSON.stringify({ at: Date.now(), v })); } catch { /* cache is optional */ }
  }

  /** What Fetcher has spent today (all runs), from their own usage records. */
  spentToday() { return this.list().filter((j) => j.usageDay === today() || (!j.usageDay && today() === (() => { const d = new Date(j.created); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; })())).reduce((a, j) => a + ((j.usage && j.usage.cost) || 0), 0); }
  file(id) { return path.join(this.dir, String(id).replace(/[^\w-]/g, '') + '.json'); }
  get(id) { try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; } }
  save(job) {
    fs.mkdirSync(this.dir, { recursive: true });
    job.updated = new Date().toISOString();
    fs.writeFileSync(this.file(job.id) + '.tmp', JSON.stringify(job));
    fs.renameSync(this.file(job.id) + '.tmp', this.file(job.id));
    this.broadcast({ type: 'fetcher', id: job.id });
    return job;
  }
  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files.map((f) => this.get(f.slice(0, -5))).filter(Boolean).sort((a, b) => (a.created < b.created ? 1 : -1));
  }
  summary(job) {
    const top = job.videos.filter((v) => v.score != null).sort((a, b) => b.score - a.score).slice(0, 3).map((v) => ({ title: v.title, score: v.score, verdict: v.verdict }));
    return { id: job.id, topic: job.topic, status: job.status, step: job.step, from: job.from, project: job.project, created: job.created, threshold: job.threshold, depth: (job.opts || {}).depth, goal: job.plan && job.plan.goal, models: job.models, videos: job.videos.length, worth_it: job.videos.filter((v) => v.verdict === 'worth it').length, top, lesson: job.lesson ? job.lesson.id : undefined, learning: job.learning, usage: job.usageLevel, budget: job.budget, used: job.usage ? job.usage.cost : 0, limitHit: job.limitHit };
  }

  /** Jobs other processes queued (agents' MCP servers), and jobs a restart interrupted: run them here. */
  pickUp() {
    for (const j of this.list().reverse()) { // oldest first, so queued runs go in the order they were asked
      if (this.running.has(j.id)) continue;
      if (j.status === 'queued' && !(j.waitUntil && Date.parse(j.waitUntil) > Date.now())) this.start(j.id);
      else if (['planning', 'searching', 'checking', 'reading', 'reviewing', 'trying', 'teaching'].includes(j.status) && Date.now() - Date.parse(j.updated) > 300000) { j.status = 'queued'; j.step = 'Restarting after an interruption'; this.save(j); this.start(j.id); }
    }
  }

  create({ topic, why, project, maxVideos, model, queries, from = 'you', byAgent = false, usage, budget, ...rest }, { start = true } = {}) {
    topic = clip(topic, 300);
    if (!topic || terms(topic).length === 0) throw new Error('Say what to research');
    const c = this.conf();
    const id = 'fx-' + crypto.randomBytes(5).toString('hex');
    const needsOk = byAgent && !c.autoRunAgentRequests;
    const level = USAGE[usage] ? usage : usage === 'custom' ? 'custom' : (USAGE[c.usage] ? c.usage : 'medium');
    const req = applyUsage(level, { maxVideos, model, ...rest });
    const opts = cleanOpts({ ...req, queries: queries || rest.queries });
    const limit = budget !== undefined && budget !== '' && budget !== null ? Math.max(0, Number(budget) || 0) : (USAGE[level] ? USAGE[level].budget : Number(c.perRunBudget) || 0);
    // Which AI plans and checks: Claude Code (default) or Codex. Usage levels name Claude models, so Codex uses its own setting.
    const tool = (rest.reviewer || c.reviewer) === 'codex' ? 'codex' : 'claude';
    const job = {
      id, topic, why: clip(why, 400) || undefined, project: project || undefined, from, created: new Date().toISOString(),
      maxVideos: Math.max(1, Math.min(12, Number(req.maxVideos) || c.maxVideos)), model: tool === 'codex' ? (String(c.codexModel || '').trim() || '') : (req.model || c.model), threshold: c.threshold, opts,
      usageLevel: level, budget: limit, tool,
      queries: buildQueries(topic, opts.queries),
      status: needsOk ? 'needs-approval' : 'queued', step: needsOk ? `Waiting for your OK (asked by ${from})` : 'Queued',
      videos: [], usage: { input: 0, output: 0, cost: 0 }, models: {},
    };
    this.save(job);
    this.store.log({ agent: from, action: 'fetcher.request', summary: `${needsOk ? 'Asked to research' : 'Research started'}: ${topic}${why ? ` (${clip(why, 100)})` : ''}`, project: job.project || FETCHER_PROJECT });
    this.card(job);
    if (!needsOk && start) this.start(id);
    return job;
  }

  approve(id, { start = true } = {}) { const j = this.get(id); if (!j) throw new Error('Not found'); if (j.status !== 'needs-approval') return j; j.status = 'queued'; j.step = 'Queued'; this.save(j); this.card(j); if (start) this.start(id); return j; }
  reject(id) { const j = this.get(id); if (!j) throw new Error('Not found'); j.status = 'rejected'; j.step = 'Declined by you'; this.save(j); this.card(j); return j; }
  remove(id) { fs.rmSync(this.file(id), { force: true }); fs.rmSync(path.join(this.dir, String(id).replace(/[^\w-]/g, '')), { recursive: true, force: true }); sessions.remove && sessions.remove(this.vault, 'fetch-' + id); this.broadcast({ type: 'fetcher' }); }

  // A Live/Agents card so the user can watch the team work, like any other agent, with the model it uses.
  card(job) {
    const status = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : job.status === 'needs-approval' ? 'needs-you' : ['rejected'].includes(job.status) ? 'done' : 'working';
    const model = (job.models && (job.models.reviewer || job.models.planner)) || job.model;
    try { sessions.upsert(this.vault, 'fetch-' + job.id, { agent: 'fetcher', title: `Fetcher: ${job.topic}`, status, step: job.step, project: job.project || FETCHER_PROJECT, launched: true, tool: 'fetcher', ...(model ? { model } : {}), ...(job.usage ? { usage: { input: job.usage.input, output: job.usage.output, cachedInput: 0 } } : {}) }); } catch { /* best effort */ }
  }

  step(job, t) { job.step = t; this.save(job); this.card(job); }

  start(id) {
    if (this.running.has(id) || !this.runner && !this.deps.ask) return; // processes without a runner only queue
    // One research run at a time: parallel runs multiply AI usage and make YouTube rate-limit the reads.
    if (this.running.size >= 1) {
      const j = this.get(id);
      if (j && j.status === 'queued' && !/^Waiting/.test(j.step || '')) { j.step = 'Waiting for the research run before it to finish'; this.save(j); this.card(j); }
      return;
    }
    this.running.add(id);
    this.run(id).catch((e) => { const j = this.get(id); if (j) { j.status = 'error'; j.step = `Failed: ${e.message}`; this.save(j); this.card(j); } })
      .finally(() => { this.running.delete(id); setImmediate(() => this.pickUp()); });
  }

  track(job, r, role) {
    if (r.usage) { job.usage.input += r.usage.input || 0; job.usage.output += r.usage.output || 0; }
    job.usage.cost += r.cost || 0;
    if (r.model) job.models[role] = r.model;
  }

  async run(id) {
    const job = this.get(id);
    job.opts = cleanOpts(job.opts || {});
    job.models = job.models || {};
    const o = job.opts;
    const dp = DEPTH[o.depth] || DEPTH.normal;
    const c = this.conf();
    const search = this.deps.search || searchYouTube;
    const related = this.deps.related || (this.deps.search ? null : relatedVideos); // tests with a fake search never hit YouTube
    const codex = job.tool === 'codex';
    const ask = this.deps.ask || (codex ? codexAsker(this.runner, job.model) : claudeAsker(this.runner, job.model));
    const planAsk = this.deps.planAsk || (this.deps.ask ? null : codex ? codexAsker(this.runner, job.model) : claudeAsker(this.runner, c.plannerModel || 'haiku'));
    const skimAsk = this.deps.skimAsk || (this.deps.ask ? null : planAsk); // the cheap model reads long videos in full
    const read = this.deps.read || (this.deps.fetchVideo ? async (vid) => {
      const v = await this.deps.fetchVideo(vid);
      return { id: vid, title: v.title, transcript: v.transcript || '', description: v.description, chapters: [], tags: [], comments: [], links: [], frames: [], transcriptSource: v.transcript ? 'captions' : 'none', speechFixes: 0, glossary: [], notes: v.note ? [v.note] : [] };
    } : (vid, ro) => reader.readVideo(vid, ro));
    const workDir = path.join(this.dir, job.id);

    // 0. daily usage limit (all Fetcher runs together): wait until tomorrow instead of spending more
    const daily = Number(c.dailyBudget) || 0;
    const spent = this.spentToday();
    if (daily && spent >= daily) {
      Object.assign(job, { status: 'queued', waitUntil: nextMidnight(), step: `Daily Fetcher limit reached ($${spent.toFixed(2)} of $${daily.toFixed(2)} used today): starts tomorrow, or raise the limit in Fetcher settings` });
      this.save(job); this.card(job);
      return job;
    }
    delete job.waitUntil;
    job.usageDay = today();
    const level = USAGE[job.usageLevel] || USAGE.medium;
    let reviewsDone = 0;
    const useCache = !this.deps.read && !this.deps.fetchVideo && !this.deps.ask; // tests with fakes never use the cache
    // Would one more review go over this run's limit or today's limit? (estimate from reviews so far)
    // Reviews already running count too, so parallel reviewers can't overshoot together.
    let inflight = 0; let resolveFirst; const firstReview = new Promise((r) => { resolveFirst = r; });
    const overLimit = () => {
      const est = reviewsDone ? job.usage.cost / reviewsDone : level.perVideo;
      const committed = job.usage.cost + inflight * est;
      if (job.budget && committed + est > job.budget * 1.05) return 'usage limit for this run reached';
      if (daily && this.spentToday() + inflight * est + est > daily) return 'daily usage limit reached';
      return null;
    };

    // 1. understand the request (AI planner; basic searches if it isn't available)
    job.status = 'planning';
    this.step(job, 'Understanding the request…');
    let plan = fallbackPlan(job);
    if (o.planner && planAsk) {
      try { const r = await planAsk(PLAN_INSTRUCTION, planInput(job, this.store)); plan = parsePlan(r.text); this.track(job, r, 'planner'); } catch (e) { plan.note = `Planner unavailable (${clip(e.message, 120)}): basic searches used`; }
    }
    job.plan = plan;
    const vocab = jobVocab(job);
    const filters = { sort: o.sort, upload: o.upload === 'auto' ? plan.recency : o.upload, length: o.length === 'auto' ? (plan.length === 'short' ? 'any' : plan.length) : o.length };
    job.filters = filters;
    const queries = [...new Set([...o.queries, ...(plan.fallback ? job.queries : [job.topic, ...plan.queries])].map((q) => clip(q, 100)).filter(Boolean))].slice(0, Math.max(dp.queries, o.queries.length));
    job.queries = queries;
    job.searches = queries.map((q) => ({ q, by: o.queries.includes(q) ? 'you' : q === job.topic ? 'your words' : plan.fallback ? 'auto' : 'planner' }));

    // 2. search every angle, fuse the rankings (a video several searches agree on ranks higher)
    job.status = 'searching';
    const pool = new Map();
    const addHits = (hits, weight, extra = {}) => hits.forEach((h, pos) => {
      const cur = pool.get(h.id) || { ...h, fusion: 0, hits: 0, ...extra };
      cur.fusion += weight / (60 + pos); cur.hits += 1;
      pool.set(h.id, cur);
    });
    for (const [i, s] of job.searches.entries()) {
      this.step(job, `Searching YouTube (${i + 1}/${job.searches.length}): "${s.q}"`);
      try { const hits = localFilter(await search(s.q, dp.perQuery, filters), o); s.found = hits.length; addHits(hits, 1); } catch (e) { s.error = clip(e.message, 120); }
    }
    let ranked = rankCandidates([...pool.values()], vocab);
    job.found = ranked.length;
    if (!ranked.length) throw new Error(`No videos found${job.searches.find((s) => s.error) ? ` (${job.searches.find((s) => s.error).error})` : ''}`);

    // 3. look beyond the searches: videos YouTube relates to the best results
    if (o.related && dp.related && related) {
      let added = 0;
      for (const top of ranked.slice(0, dp.related)) {
        this.step(job, `Exploring videos related to: ${clip(top.title, 60)}`);
        try { const rel = localFilter(await related(top.id), o).filter((v) => !pool.has(v.id)); added += rel.length; addHits(rel.slice(0, 10), 0.5, { via: clip(top.title, 80) }); } catch { /* skip */ }
      }
      job.relatedFound = added;
      ranked = rankCandidates([...pool.values()], vocab);
    }

    // 4. read the best-ranked (speech cleaned and corrected, chapters), then the free pre-check
    job.status = 'reading';
    const reviewedIds = new Set();
    const readPool = async (cands, label) => {
      const out = [];
      await pmap(cands, 2, async (cand, i) => {
        this.step(job, `${label} ${i + 1}/${cands.length}: ${clip(cand.title, 60)}`);
        let d = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const cached = useCache ? this.cacheGet('read-' + cand.id, 7) : null;
          if (cached) { d = cached; break; }
          try { d = await read(cand.id, { vocab }); } catch (e) { d = { notes: [e.message] }; }
          if (useCache && d && d.transcript) this.cachePut('read-' + cand.id, d);
          if ((d && d.transcript) || !/\b429\b|too many requests/i.test(String((d && d.notes || []).join(' ')))) break;
          await new Promise((r) => setTimeout(r, (this.deps.retryMs ?? 5000) * (attempt + 1)));
        }
        const v = { ...d, ...cand, channel: cand.channel || d.channel, duration: cand.duration || d.duration, title: cand.title || d.title, transcript: d.transcript || '', transcriptNote: d.transcript ? undefined : (d.notes || []).join('; ') };
        v.pre = preCheck(v, vocab);
        out.push(v);
      });
      return out.sort((a, b) => b.pre.score - a.pre.score || b.rank - a.rank);
    };
    const shortlistOf = (fetched, n) => fetched.filter((v) => v.pre.score >= 25 && !reviewedIds.has(v.id)).slice(0, n);
    const slot = (v) => ({ id: v.id, title: v.title, channel: v.channel, duration: v.duration, views: v.views, uploaded: v.uploaded, rank: v.rank, via: v.via, hits: v.hits, pre: v.pre, transcriptSource: v.transcriptSource, speechFixes: v.speechFixes, transcriptNote: v.transcriptNote });

    // 5. full read of the shortlist (comments, linked pages, screen frames), then the usefulness checker
    const review = async (shortlist, round) => {
      job.status = 'reviewing';
      let done = 0;
      await pmap(shortlist, Math.max(1, Math.min(4, o.team || c.team)), async (v) => {
        reviewedIds.add(v.id);
        const s = job.videos.find((x) => x.id === v.id);
        // The first review runs alone so the real cost per review is known before spending in parallel.
        if (!reviewsDone && inflight > 0 && (job.budget || daily)) await firstReview;
        // Stop before a paid review would go over this run's (or today's) usage limit.
        const stop = overLimit();
        if (stop) { s.skipped = stop; job.limitHit = stop; done++; this.step(job, `Stopped reviewing: ${stop} (${job.usage.cost.toFixed(3)} used)`); return; }
        inflight++;
        const framesDir = path.join(workDir, v.id);
        const reviewKey = 'review-' + crypto.createHash('sha1').update([v.id, (plan.goal || job.topic).toLowerCase(), job.tool === 'codex' ? 'codex:' + job.model : job.model, REVIEW_VERSION].join('|')).digest('hex').slice(0, 20);
        const hit = useCache ? this.cacheGet(reviewKey, 14) : null;
        if (hit && hit.review) { Object.assign(s, { review: hit.review, ...worth(hit.review, job.threshold), cached: true, round, comments: hit.comments, links: hit.links, frames: hit.frames, chapters: hit.chapters }); done++; this.step(job, `Usefulness checker: ${done}/${shortlist.length} (reused an earlier review, no cost)`); return; }
        const framesOk = o.frames && o.maxFrames > 0 && shortlist.indexOf(v) < (level.framesFor ?? 12);
        try {
          let full = v;
          if (!this.deps.fetchVideo) {
            try { const d = await read(v.id, { vocab, full: true, comments: o.comments, links: o.links, frames: framesOk, maxFrames: o.maxFrames, framesDir }); full = { ...v, ...d, ...{ title: v.title || d.title, pre: v.pre, rank: v.rank, via: v.via } }; } catch (e) { full.notes = [...(v.notes || []), `full read: ${e.message}`]; }
          }
          Object.assign(s, { comments: (full.comments || []).length, links: (full.links || []).length, frames: (full.frames || []).length, glossary: (full.glossary || []).slice(0, 20), chapters: (full.chapters || []).length, round });
          // Long video: the checker only sees an excerpt, so skim the whole transcript first with the cheap model
          // (skipped on Low, and when it would use more than a third of what is left of the run's limit).
          const exMax = level.excerpt || 7000;
          if (skimAsk && level.skim !== false && (full.transcript || '').length > 2.5 * exMax) {
            const est = (full.transcript.length / 4 / 1e6) * 1.6; // cheap-model input at ~$1/M tokens, plus replies
            const cached = useCache ? this.cacheGet('skim-' + crypto.createHash('sha1').update(v.id + '|' + (plan.goal || job.topic).toLowerCase()).digest('hex').slice(0, 20), 14) : null;
            if (cached) { full.skim = cached.moments; s.skim = { moments: cached.moments.length, cached: true }; }
            else if (job.budget && est > (job.budget - job.usage.cost) / 3) s.skim = { skipped: 'not enough of the usage limit left' };
            else {
              this.step(job, `Skimming the whole of a ${Math.round((full.duration || 0) / 60)}-minute video: ${clip(v.title, 50)}`);
              try {
                const sk = await skimTranscript(skimAsk, job, full);
                sk.runs.forEach((r) => this.track(job, r, 'skimmer'));
                full.skim = sk.moments; s.skim = { moments: sk.moments.length, parts: sk.parts };
                if (useCache) this.cachePut('skim-' + crypto.createHash('sha1').update(v.id + '|' + (plan.goal || job.topic).toLowerCase()).digest('hex').slice(0, 20), { moments: sk.moments });
              } catch (e) { s.skim = { error: clip(e.message, 160) }; }
            }
          }
          const hasFrames = (full.frames || []).length > 0;
          let r = await ask(REVIEW_INSTRUCTION, reviewInput(job, full), hasFrames ? { tools: 'Read', cwd: framesDir } : {});
          let rv;
          try { rv = parseReview(r.text); } catch (e) {
            // a cut-off or malformed reply: ask once more for just the JSON, shorter (unless that would pass the limit)
            this.track(job, r, 'reviewer');
            if (overLimit()) throw e;
            this.step(job, `Usefulness checker: reply for "${clip(v.title, 40)}" was broken, asking again…`);
            r = await ask(REVIEW_INSTRUCTION + '\nYour previous reply was cut off or was not valid JSON. Keep every field short (evidence under 200 characters) and reply with ONLY the JSON object.', reviewInput(job, full), {});
            rv = parseReview(r.text);
            s.retried = true;
          }
          Object.assign(s, { review: rv, ...worth(rv, job.threshold) });
          this.track(job, r, 'reviewer');
          reviewsDone++;
          if (useCache) this.cachePut(reviewKey, { review: rv, comments: s.comments, links: s.links, frames: s.frames, chapters: s.chapters });
        } catch (e) { s.error = clip(e.message, 300); }
        inflight--; resolveFirst();
        fs.rm(framesDir, { recursive: true, force: true }, () => {});
        done++;
        this.step(job, `Usefulness checker${round > 1 ? ' (round 2)' : ''}: ${done}/${shortlist.length} videos reviewed`);
      });
    };

    const fetched = await readPool(ranked.slice(0, dp.pool(job.maxVideos)), 'Reading video');
    const shortlist = shortlistOf(fetched, job.maxVideos);
    const shortSet = new Set(shortlist.map((v) => v.id));
    const why = (v, n) => (!v.pre.transcript && v.pre.score < 25 ? 'no transcript' : v.pre.score < 25 ? 'pre-check too low' : `not in the top ${n}`);
    job.videos = fetched.map((v) => ({ ...slot(v), ...(shortSet.has(v.id) ? {} : { skipped: why(v, job.maxVideos) }) }));
    if (shortlist.length) await review(shortlist, 1);

    // 6. deep: a second round aimed at what the first one missed
    // (only with budget to spare: a second round is skipped once 60% of the run's limit is used)
    if (dp.round2 && planAsk && !plan.fallback && shortlist.length && !job.limitHit && !(job.budget && job.usage.cost >= job.budget * 0.6)) {
      try {
        job.status = 'planning';
        this.step(job, 'Deep research: planning a second round for what is still missing…');
        const seenQ = new Set(job.queries.map((q) => q.toLowerCase()));
        const summary = job.videos.filter((v) => v.review).map((v) => `- ${v.title} (${v.verdict}, ${v.score}): ${v.review.summary}`).join('\n');
        const r = await planAsk(FOLLOWUP_INSTRUCTION, `Goal: ${plan.goal}\nRequest: ${job.topic}\nEarlier searches: ${job.queries.join(' | ')}\nReviewed so far:\n${summary}`);
        this.track(job, r, 'planner');
        const fu = parseJsonObject(r.text);
        const more = strList(fu.queries, 4, 100).filter((q) => !seenQ.has(q.toLowerCase()));
        job.missing = clip(fu.missing, 300);
        if (more.length) {
          job.status = 'searching';
          const before = new Set(pool.keys());
          for (const q of more) {
            const s = { q, by: 'follow-up' };
            job.searches.push(s); job.queries.push(q);
            this.step(job, `Deep research: searching "${q}"`);
            try { const hits = localFilter(await search(q, dp.perQuery, filters), o); s.found = hits.length; addHits(hits, 1); } catch (e) { s.error = clip(e.message, 120); }
          }
          const fresh = rankCandidates([...pool.values()].filter((v) => !before.has(v.id)), vocab);
          job.found = pool.size;
          if (fresh.length) {
            job.status = 'reading';
            const f2 = await readPool(fresh.slice(0, Math.max(2, Math.ceil(job.maxVideos))), 'Deep research: reading');
            const s2 = shortlistOf(f2, Math.max(1, Math.ceil(job.maxVideos / 2)));
            const s2Set = new Set(s2.map((v) => v.id));
            job.videos.push(...f2.map((v) => ({ ...slot(v), round: 2, ...(s2Set.has(v.id) ? {} : { skipped: why(v, s2.length) }) })));
            if (s2.length) await review(s2, 2);
          }
        }
      } catch (e) { job.deepNote = `Second round skipped: ${clip(e.message, 160)}`; }
    }
    fs.rm(workDir, { recursive: true, force: true }, () => {});

    if (!job.videos.some((v) => v.review)) {
      job.status = 'done';
      this.step(job, `Done: none of ${job.videos.length} videos passed the pre-check${job.videos.some((v) => v.skipped === 'no transcript') ? ' (some had no transcript)' : ''}`);
      this.writeReport(job);
      return job;
    }

    // 7. tryout: apply each worth-it technique to one of the user's real tasks; generalise it or drop it
    await this.tryout(job, ask, overLimit);

    // 8. teach + verify agents can find it
    job.status = 'teaching';
    const lesson = teach(this.store, job);
    if (lesson) { job.lesson = lesson; job.learning = recallCheck(this.store, job, lesson.id); }
    job.status = 'done';
    const worthIt = job.videos.filter((v) => v.verdict === 'worth it').length;
    this.step(job, lesson ? `Done: ${worthIt} worth-it video${worthIt === 1 ? '' : 's'} → ${lesson.techniques} technique${lesson.techniques === 1 ? '' : 's'} taught in "${lesson.title}"` : `Done: no video was worth it (${job.videos.filter((v) => v.review).length} reviewed)`);
    this.writeReport(job);
    this.store.log({ agent: 'fetcher', model: job.models.reviewer, action: 'fetcher.done', summary: `Researched "${job.topic}": ${job.videos.length} videos read, ${worthIt} worth it${lesson ? `, taught ${lesson.techniques} techniques` : ''}`, project: job.project || FETCHER_PROJECT, ref: lesson && lesson.id });
    return job;
  }

  /** One AI call for all candidates of the run. If it can't run (limit reached, error), techniques are taught
   *  as the checker wrote them and the report says they weren't tried out. */
  async tryout(job, ask, overLimit = () => null) {
    const cands = tryoutCandidates(job).filter((c) => !c.t.tryout && !c.t.dropped && c.t.evidence);
    if (!cands.length || !ask) return;
    const stop = overLimit();
    if (stop) { job.tryout = { skipped: stop }; return; }
    job.status = 'trying';
    this.step(job, `Trying out ${cands.length} technique${cands.length === 1 ? '' : 's'} on your real tasks…`);
    try {
      const r = await ask(TRYOUT_INSTRUCTION, tryoutInput(this.store, job, cands));
      this.track(job, r, 'tryout');
      job.tryout = { ...applyTryout(cands, r.text), reply: clip(r.text, 4000) }; // the raw answer stays in the run file for diagnosis
    } catch (e) { job.tryout = { error: clip(e.message, 200) }; }
  }

  /** Apply the current "worth it" threshold to a finished run (no new AI calls) and re-teach. */
  rescore(id) {
    const job = this.get(id);
    if (!job) throw new Error('Not found');
    job.threshold = this.conf().threshold;
    for (const v of job.videos) if (v.review) Object.assign(v, worth(v.review, job.threshold));
    const lesson = teach(this.store, job);
    if (lesson) { job.lesson = lesson; job.learning = recallCheck(this.store, job, lesson.id); }
    const n = job.videos.filter((v) => v.verdict === 'worth it').length;
    job.step = `Re-scored at ${job.threshold}: ${n} worth it${lesson ? ` → ${lesson.techniques} techniques in "${lesson.title}"` : ''}`;
    this.store.log({ agent: 'fetcher', action: 'fetcher.rescore', summary: `Re-scored "${job.topic}" at ${job.threshold}: ${n} worth it${lesson ? `, lesson has ${lesson.techniques} techniques` : ''}`, project: job.project, ref: lesson && lesson.id });
    this.writeReport(job);
    this.card(job);
    return this.save(job);
  }

  /** Teach a single video the user picked (e.g. a "maybe"). */
  teachVideo(id, videoId) {
    const job = this.get(id);
    if (!job) throw new Error('Not found');
    const v = job.videos.find((x) => x.id === videoId);
    if (!v || !v.review) throw new Error('That video has no review to teach from');
    v.taught = true;
    job.lesson = teach(this.store, job);
    job.learning = recallCheck(this.store, job, job.lesson.id);
    this.writeReport(job);
    return this.save(job);
  }

  writeReport(job) {
    try {
      const dir = path.join(this.vault, 'fetcher');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${job.created.slice(0, 10)}-${terms(job.topic).slice(0, 6).join('-') || job.id}-${job.id.slice(3, 7)}.md`);
      fs.writeFileSync(f, reportMarkdown(job));
      job.report = path.relative(this.vault, f).replace(/\\/g, '/');
      this.save(job);
    } catch { /* report is a convenience */ }
  }
}

async function pmap(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } }));
}

/** Preview text for a lesson note (used by recall and briefs instead of the generic excerpt). */
function lessonPreview(rec, max = 420) {
  try { const techs = JSON.parse(rec.meta.fetcher_lesson || '[]'); if (techs.length) return clip(`LESSON (vetted, ${techs.length} techniques; after using one, report it with lesson_feedback): ${takeaways(techs, 4).join(' | ')}`, max); } catch { /* fall through */ }
  return '';
}

module.exports = {
  lessonPreview, takeaways, __claudeAsker: claudeAsker, __codexAsker: codexAsker, codexModels, __reviewInput: reviewInput, Fetcher, buildQueries, parseSearchPage, parseRelated, rankCandidates,
  preCheck, excerpt, parseReview, parsePlan, worth, teach, recallCheck, lessonTitle, recordFeedback, applyTryout, tryoutInput, TRYOUT_INSTRUCTION, SKIM_INSTRUCTION, skimTranscript, transcriptParts, whenText, FADE_AFTER, lessonBody, REVIEW_INSTRUCTION, PLAN_INSTRUCTION, searchYouTube, encodeSp, localFilter, relevance, cleanOpts, jobVocab, MAX_TECHNIQUES, USAGE, applyUsage,
};
