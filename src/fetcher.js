'use strict';
// Fetcher: AI agents look through YouTube to learn how to do things better.
//
//   request → search (several queries) → rank → fetch transcripts → free local pre-check
//   → usefulness checker (a small team of AI reviewers, one video each) → worth-it score (fixed formula)
//   → teach: worth-it techniques become a "Lesson: <topic>" memory (merged across runs) → recall self-check.
//
// Requests come from the user (Fetcher tab, phone) or from agents (MCP fetcher_request). Agent requests
// wait for the user's approval unless settings.fetcher.autoRunAgentRequests is on, so they can't spend usage alone.
// Full reports go to <vault>/fetcher/*.md (readable in Obsidian, not loaded into agents' context).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const media = require('./media');
const sessions = require('./sessions');
const settingsMod = require('./settings');

const STOP = new Set('the a an and or of to in on for with how what why is are do does did i my your you it its this that be can best way ways use using vs from at by as into about get make more less than so if not no yes all any just like will'.split(' '));
const terms = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.\-]+/g) || [])].filter((t) => !STOP.has(t) && t.length > 1);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOWTO = /\b(step|first|then|next|you can|you should|make sure|instead of|command|run|set up|setup|configure|install|use|tip|trick|workflow|prompt|template|faster|automate|shortcut|example|mistake|avoid)\b/gi;

// ---------- queries & search ----------
function buildQueries(topic, extra = []) {
  const t = String(topic || '').trim();
  return [...new Set([...extra.map(String), t, `${t} tutorial`, `${t} best practices`, `${t} tips workflow`].map((s) => s.trim()).filter(Boolean))].slice(0, 5);
}

const parseDuration = (s) => { if (!s) return undefined; const p = String(s).split(':').map(Number); return p.some(isNaN) ? undefined : p.reduce((a, b) => a * 60 + b, 0); };
const parseViews = (s) => { const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i); if (!m) return undefined; return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || '').toUpperCase()] || 1)); };
const parseAge = (s) => { const m = String(s || '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i); if (!m) return undefined; return Number(m[1]) * ({ second: 0, minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()]); };
const text = (x) => (x ? x.simpleText || (x.runs || []).map((r) => r.text).join('') : '');

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

const run = (bin, args, timeout) => new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: media.toolEnv() }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').pop())) : resolve(out))));

// The public results page is fast (<1 s) and needs no key; yt-dlp search (~30 s) is the fallback.
async function searchYouTube(query, n = 10) {
  try {
    const page = await media.safeFetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`, { headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
    const list = parseSearchPage(page.text).slice(0, n);
    if (list.length) return list;
  } catch { /* try yt-dlp */ }
  const bin = process.env.CORTEX_YTDLP || await media.which('yt-dlp');
  if (!bin) throw new Error('YouTube search returned nothing (and yt-dlp is not installed)');
  const j = JSON.parse(await run(bin, ['--flat-playlist', '-J', '--no-warnings', `ytsearch${n}:${query}`], 90000));
  return (j.entries || []).filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title, channel: e.channel || e.uploader, duration: e.duration || undefined, views: e.view_count || undefined, snippet: e.description || '' }));
}

/** Rank search results before spending anything on them: title relevance, popularity, length, age. */
function rankCandidates(list, topic) {
  const tt = terms(topic);
  const seen = new Set();
  return list.filter((v) => v && v.id && !seen.has(v.id) && seen.add(v.id)).map((v) => {
    const tw = terms(`${v.title} ${v.snippet || ''}`);
    const rel = tt.length ? tt.filter((t) => tw.some((w) => w === t || w.startsWith(t) || t.startsWith(w))).length / tt.length : 0;
    const views = v.views ? Math.min(1, Math.log10(v.views + 1) / 6) : 0.3;
    const d = v.duration || 0;
    const dur = !d ? 0.5 : d < 120 ? 0.1 : d <= 2700 ? 1 : d <= 5400 ? 0.6 : 0.3; // shorts and 2-hour streams rarely teach a technique well
    const age = v.ageDays == null ? 0.6 : v.ageDays < 365 ? 1 : v.ageDays < 1095 ? 0.7 : 0.4;
    return { ...v, rank: Math.round(100 * (0.5 * rel + 0.2 * views + 0.15 * dur + 0.15 * age)) };
  }).sort((a, b) => b.rank - a.rank);
}

// ---------- free local pre-check ----------
function preCheck(v, topic) {
  const tx = String(v.transcript || '');
  const words = tx.split(/\s+/).filter(Boolean).length;
  if (words < 40) {
    const d = String(v.description || '');
    return { score: d.length > 400 ? 22 : 5, words: 0, transcript: false, reason: 'No transcript: only the title and description could be checked' };
  }
  const tt = terms(topic);
  const low = tx.toLowerCase();
  const hits = tt.map((t) => (low.match(new RegExp(`\\b${reEsc(t)}`, 'g')) || []).length);
  const coverage = tt.length ? hits.filter((h) => h > 0).length / tt.length : 0;
  const density = Math.min(1, hits.reduce((a, b) => a + b, 0) / Math.max(1, words / 100) / 3);
  const howto = Math.min(1, (low.match(HOWTO) || []).length / Math.max(1, words / 1000) / 25);
  const len = words < 300 ? 0.3 : 1;
  const score = Math.round(100 * (0.4 * coverage + 0.25 * density + 0.25 * howto + 0.1 * len));
  return { score, words, transcript: true, coverage: Math.round(coverage * 100), howto: Math.round(howto * 100), reason: `${Math.round(coverage * 100)}% of the topic's words appear; how-to density ${Math.round(howto * 100)}%; ${words} words` };
}

/** The most relevant parts of a long transcript (keeps timestamps), so reviewers read ~2k tokens, not 20k. */
function excerpt(tx, topic, max = 7000) {
  tx = String(tx || '');
  if (tx.length <= max) return tx;
  // Cut along the transcript's own timestamped segments, never mid-sentence, packed into ~900-char chunks.
  const size = 900;
  const segs = tx.split(/\n\s*\n|(?=\[\d{1,2}:\d{2}(?::\d{2})?\])/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const s of segs) {
    if (cur && cur.length + s.length + 1 > size) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  const tt = terms(topic);
  const scored = chunks.map((t, i) => { const l = t.toLowerCase(); return { i, t: t.slice(0, 2 * size), s: tt.reduce((a, w) => a + (l.split(w).length - 1), 0) + 0.5 * (l.match(HOWTO) || []).length }; });
  const keep = new Set([0]);
  let used = scored[0].t.length;
  for (const c of [...scored].sort((a, b) => b.s - a.s)) {
    if (keep.has(c.i)) continue;
    if (used + c.t.length > max) continue;
    keep.add(c.i); used += c.t.length + 5;
  }
  return scored.filter((c) => keep.has(c.i)).map((c) => c.t).join('\n[…]\n');
}

// ---------- usefulness checker ----------
const REVIEW_INSTRUCTION = 'You are the Cortex usefulness checker. Review the one YouTube video given on stdin for an AI agent team (coding and work agents such as Claude Code and Codex that work through Cortex, a project manager and long-term memory). Decide what in it would make agents perform tasks better, faster or cheaper, and exactly how an agent would apply it. Be strict: generic advice, hype, outdated tips and things only a human can do score low. Use only the material given; never invent techniques that are not in it.\n'
  + 'Reply with ONLY one JSON object and nothing else:\n'
  + '{"summary":"two sentences","techniques":[{"name":"short name","when":"the situation in which an agent should use it","do":"concrete steps the agent takes","why":"the expected benefit","evidence":"timestamp like 03:12 and/or a short quote from the transcript"}],"applies_to":["task types"],"impact":1,"applicability":1,"confidence":1,"effort":1,"risk":1,"reasoning":"one or two sentences explaining the ratings"}\n'
  + 'Ratings are integers 1-5. impact: how much better agents\' work gets. applicability: how often agents\' tasks hit this. confidence: how sure you are it is correct and current (2 or less without a transcript). effort: cost to adopt (1 easy, 5 hard). risk: chance it causes mistakes or harm (1 low, 5 high). At most 4 techniques; an empty list if nothing is useful.';

function reviewInput(job, v) {
  return [
    `Research topic: ${job.topic}`,
    job.why ? `Why it was requested: ${job.why}` : '',
    `Video: ${v.title} — ${v.channel || 'unknown channel'}${v.duration ? ` — ${Math.round(v.duration / 60)} min` : ''} — https://www.youtube.com/watch?v=${v.id}`,
    v.description ? `Description: ${clip(v.description, 800)}` : '',
    `Local pre-check: ${v.pre.reason}`,
    '',
    v.pre.transcript ? `Transcript (most relevant parts, with timestamps):\n${excerpt(v.transcript, job.topic)}` : 'No transcript was available.',
  ].filter((x) => x !== '').join('\n');
}

const rating = (x) => Math.max(1, Math.min(5, Math.round(Number(x) || 1)));
/** Pull the JSON object out of the reviewer's reply and make it safe and well-formed. */
function parseReview(reply) {
  const s = String(reply || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The reviewer did not return JSON');
  const j = JSON.parse(s.slice(start, end + 1));
  return {
    summary: clip(j.summary, 500),
    techniques: (Array.isArray(j.techniques) ? j.techniques : []).slice(0, 4).filter((t) => t && t.name).map((t) => ({ name: clip(t.name, 80), when: clip(String(t.when || '').replace(/^\s*when\s+/i, ''), 300), do: clip(t.do, 500), why: clip(t.why, 300), evidence: clip(t.evidence, 200) })),
    applies_to: (Array.isArray(j.applies_to) ? j.applies_to : []).slice(0, 6).map((x) => clip(x, 60)),
    impact: rating(j.impact), applicability: rating(j.applicability), confidence: rating(j.confidence), effort: rating(j.effort), risk: rating(j.risk),
    reasoning: clip(j.reasoning, 400),
  };
}

/**
 * Worth-it score 0-100, calculated by Cortex (not by the AI) from the reviewer's ratings:
 *   35% impact + 25% applicability + 15% confidence + 15% low effort + 10% low risk   (each rating mapped 1..5 → 0..1)
 * Verdict: ≥ threshold (60) "worth it", ≥ 45 "maybe", else "not worth it". Low confidence (≤ 2) or no techniques can't be "worth it".
 */
function worth(r, threshold = 60) {
  const n = (x) => (rating(x) - 1) / 4;
  const score = Math.round(100 * (0.35 * n(r.impact) + 0.25 * n(r.applicability) + 0.15 * n(r.confidence) + 0.15 * (1 - n(r.effort)) + 0.10 * (1 - n(r.risk))));
  let verdict = score >= threshold ? 'worth it' : score >= 45 ? 'maybe' : 'not worth it';
  if (verdict === 'worth it' && (rating(r.confidence) <= 2 || !(r.techniques || []).length)) verdict = 'maybe';
  return { score, verdict };
}

/** Ask Claude Code (no tools) for a reply. Hooks stay quiet (CORTEX_QUIET) so no Cortex brief is added. */
function claudeAsker(runner, model) {
  return async (instruction, input) => {
    await runner.available();
    const bin = runner.bin('claude');
    // No built-in tools and no MCP servers: the reviewer only reads and answers (and loads no tool definitions).
    const args = ['-p', instruction, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(model ? ['--model', model] : [])];
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { cwd: os.tmpdir(), env: { ...process.env, CORTEX_QUIET: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error('The reviewer took longer than 4 minutes')); }, 240000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.stdin.on('error', () => {});
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        clearTimeout(t);
        let j = null;
        try { j = JSON.parse(out); } catch { /* not json */ }
        if (!j || j.is_error) return reject(new Error(clip((j && j.result) || err || out || `Claude Code exited with ${code}`, 300)));
        const u = j.usage || {};
        resolve({ text: j.result, usage: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 }, cost: j.total_cost_usd || 0, model: j.model });
      });
      p.stdin.end(input);
    });
  };
}

// ---------- teaching: lessons agents actually find and use ----------
const normName = (s) => terms(s).sort().join(' ');
const lessonTitle = (topic) => clip(`Lesson: ${String(topic).trim()}`, 90);

/** One line per technique, for previews (recall, briefs, excerpts): the advice itself, not the boilerplate. */
function takeaways(techs, max = 6) {
  return techs.slice(0, max).map((t) => `${t.name}: ${clip(t.when ? `when ${String(t.when).replace(/^\s*when\s+/i, '')} → ` : '', 110)}${clip(t.do, 150)}${require('./lesson-guard').marker(t)}`);
}

function lessonBody(topic, techs, stats, quarantined = []) {
  const lines = [
    `# ${lessonTitle(topic)}`, '',
    'Key takeaways (apply the ones that match your task):',
    ...takeaways(techs, 10).map((t) => `- ${t}`), '',
    `> Learned by Cortex Fetcher from YouTube (${stats.videos} video${stats.videos === 1 ? '' : 's'} passed the usefulness checker; last run ${stats.date}). Each technique scored "worth it" (≥ ${stats.threshold}/100). Say which technique you used. Ask the user before installing any tool or service a technique names. Reports with every video checked: vault folder fetcher/.`, '',
    ...(quarantined.length ? [`> ${quarantined.length} technique${quarantined.length === 1 ? ' was' : 's were'} quarantined by the safety check and are NOT shown to agents (kept for review in this note's fetcher_quarantine field).`, ''] : []),
    '## Techniques in detail', '',
  ];
  for (const t of techs) {
    lines.push(`### ${t.name}`, `- **When:** ${t.when || '—'}`, `- **Do:** ${t.do || '—'}`, `- **Why:** ${t.why || '—'}`, `- **Trust:** ${t.trust || 'unknown'}${t.safety === 'ask' ? ` · ⚠ ask the user before doing this (${(t.safety_reasons || []).join(', ')})` : ''}`,
      `- **Sources:** ${t.sources.map((s) => `[${clip(s.title, 70)}](${s.url}) (score ${s.score}${s.evidence ? `, ${clip(s.evidence, 60)}` : ''})`).join('; ')}`, '');
  }
  return lines.join('\n');
}

/** Merge this job's worth-it techniques into "Lesson: <topic>" (same technique from several videos → one entry, all sources). */
function teach(store, job) {
  const good = job.videos.filter((v) => v.review && (v.verdict === 'worth it' || v.taught));
  if (!good.length) return null;
  const title = lessonTitle(job.topic);
  const existing = store.list('note', job.project ? { project: job.project } : { scope: 'system' }).find((r) => r.title === title);
  let techs = [];
  try { techs = existing && existing.meta.fetcher_lesson ? JSON.parse(existing.meta.fetcher_lesson) : []; } catch { techs = []; }
  try { if (existing && existing.meta.fetcher_quarantine) techs = techs.concat(JSON.parse(existing.meta.fetcher_quarantine)); } catch { /* ignore */ }
  const byName = new Map(techs.map((t) => [normName(t.name), t]));
  for (const v of good) {
    for (const t of v.review.techniques) {
      const k = normName(t.name);
      const src = { title: v.title, url: `https://www.youtube.com/watch?v=${v.id}`, score: v.score, evidence: t.evidence };
      const cur = byName.get(k);
      if (cur) { if (!cur.sources.some((s) => s.url === src.url)) cur.sources.push(src); if (String(t.do).length > String(cur.do).length) Object.assign(cur, { when: t.when, do: t.do, why: t.why }); }
      else byName.set(k, { name: t.name, when: t.when, do: t.do, why: t.why, sources: [src] });
    }
  }
  techs = [...byName.values()].sort((a, b) => b.sources.length - a.sources.length || Math.max(...b.sources.map((s) => s.score)) - Math.max(...a.sources.map((s) => s.score)));
  const safe = require('./lesson-guard').guard(techs); // provenance + injection/danger scan; quarantined ones never reach agents
  techs = safe.active;
  const videos = new Set(techs.flatMap((t) => t.sources.map((s) => s.url))).size;
  const body = lessonBody(job.topic, techs, { videos, date: new Date().toISOString().slice(0, 10), threshold: job.threshold }, safe.quarantined);
  const meta = { type: 'reference', tags: ['lesson', 'fetcher'], fetcher_lesson: JSON.stringify(techs), fetcher_quarantine: JSON.stringify(safe.quarantined), agent: 'fetcher' };
  const rec = existing ? store.update(existing.id, { body, ...meta }) : store.create('note', { title, body, ...meta, ...(job.project ? { project: job.project } : {}) });
  return { id: rec.id, techniques: techs.length, quarantined: safe.quarantined.length, merged: !!existing };
}

/** Does an agent asking about the topic actually get the lesson? (Same search Cortex's recall uses.) */
function recallCheck(store, job, lessonId) {
  const f = job.project ? { scope: 'project+system', projectScope: job.project } : { scope: 'system' };
  const hits = store.search(job.topic, { kind: 'note', limit: 5, minMatch: 1, ...f }).filter((h) => !h.rec.meta.agent_journal);
  const rank = hits.findIndex((h) => h.rec.id === lessonId);
  return { found: rank >= 0 && rank < 3, rank: rank >= 0 ? rank + 1 : null, query: job.topic };
}

function reportMarkdown(job) {
  const row = (v) => `| [${clip(v.title, 60).replace(/\|/g, '/')}](https://www.youtube.com/watch?v=${v.id}) | ${v.pre ? v.pre.score : '—'} | ${v.score != null ? v.score : '—'} | ${v.verdict || v.skipped || '—'} | ${clip(v.review ? v.review.reasoning : v.error || (v.pre && v.pre.reason) || '', 140).replace(/\|/g, '/')} |`;
  return [
    `# Fetcher report: ${job.topic}`, '',
    `- **Requested by:** ${job.from}${job.why ? ` — ${job.why}` : ''}`,
    `- **When:** ${job.created.slice(0, 16).replace('T', ' ')} · **Status:** ${job.status}${job.project ? ` · **Project:** ${job.project}` : ''}`,
    `- **Searches:** ${job.queries.map((q) => `"${q}"`).join(', ')} → ${job.found || 0} videos found, ${job.videos.length} checked`,
    `- **Usefulness checker:** ${job.model || 'default model'} · ${job.usage.input.toLocaleString()} input / ${job.usage.output.toLocaleString()} output tokens${job.usage.cost ? ` · $${job.usage.cost.toFixed(3)}` : ''}`,
    job.lesson ? `- **Taught:** [[${lessonTitle(job.topic)}]] (${job.lesson.techniques} techniques${job.lesson.merged ? ', merged with earlier runs' : ''}) · recall check: ${job.learning && job.learning.found ? `found at #${job.learning.rank}` : 'NOT found in the top 3'}` : '- **Taught:** nothing passed the checker',
    '', '| Video | Pre-check | Worth-it | Verdict | Why |', '|---|---|---|---|---|', ...job.videos.map(row), '',
    ...job.videos.filter((v) => v.review && v.review.techniques.length).flatMap((v) => [`## ${clip(v.title, 90)} (${v.score}, ${v.verdict})`, '', v.review.summary, '', ...v.review.techniques.map((t) => `- **${t.name}** — when: ${t.when} · do: ${t.do} · why: ${t.why}${t.evidence ? ` · (${t.evidence})` : ''}`), '']),
  ].join('\n');
}

// ---------- jobs ----------
class Fetcher {
  constructor({ store, runner, broadcast = () => {}, deps = {} }) {
    this.store = store;
    this.vault = store.vault;
    this.runner = runner;
    this.broadcast = broadcast;
    this.deps = deps; // tests: { search, fetchVideo, ask }
    this.dir = path.join(this.vault, '.cortex', 'fetcher');
    this.running = new Set();
  }

  conf() { return { maxVideos: 5, team: 3, model: 'sonnet', threshold: 60, autoRunAgentRequests: false, ...(settingsMod.load(this.vault).fetcher || {}) }; }
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
    return { id: job.id, topic: job.topic, status: job.status, step: job.step, from: job.from, project: job.project, created: job.created, threshold: job.threshold, videos: job.videos.length, worth_it: job.videos.filter((v) => v.verdict === 'worth it').length, top, lesson: job.lesson ? job.lesson.id : undefined, learning: job.learning };
  }

  /** Jobs other processes queued (agents' MCP servers), and jobs a restart interrupted: run them here. */
  pickUp() {
    for (const j of this.list()) {
      if (this.running.has(j.id)) continue;
      if (j.status === 'queued') this.start(j.id);
      else if (['searching', 'checking', 'reviewing', 'teaching'].includes(j.status) && Date.now() - Date.parse(j.updated) > 300000) { j.status = 'queued'; j.step = 'Restarting after an interruption'; this.save(j); this.start(j.id); }
    }
  }

  create({ topic, why, project, maxVideos, model, queries, from = 'you', byAgent = false }, { start = true } = {}) {
    topic = clip(topic, 160);
    if (!topic || terms(topic).length === 0) throw new Error('Say what to research');
    const c = this.conf();
    const id = 'fx-' + crypto.randomBytes(5).toString('hex');
    const needsOk = byAgent && !c.autoRunAgentRequests;
    const job = {
      id, topic, why: clip(why, 400) || undefined, project: project || undefined, from, created: new Date().toISOString(),
      maxVideos: Math.max(1, Math.min(12, Number(maxVideos) || c.maxVideos)), model: model || c.model, threshold: c.threshold,
      queries: buildQueries(topic, Array.isArray(queries) ? queries.slice(0, 3) : []),
      status: needsOk ? 'needs-approval' : 'queued', step: needsOk ? `Waiting for your OK (asked by ${from})` : 'Queued',
      videos: [], usage: { input: 0, output: 0, cost: 0 },
    };
    this.save(job);
    this.store.log({ agent: from, action: 'fetcher.request', summary: `${needsOk ? 'Asked to research' : 'Research started'}: ${topic}${why ? ` (${clip(why, 100)})` : ''}`, project: job.project });
    this.card(job);
    if (!needsOk && start) this.start(id);
    return job;
  }

  approve(id, { start = true } = {}) { const j = this.get(id); if (!j) throw new Error('Not found'); if (j.status !== 'needs-approval') return j; j.status = 'queued'; j.step = 'Queued'; this.save(j); this.card(j); if (start) this.start(id); return j; }
  reject(id) { const j = this.get(id); if (!j) throw new Error('Not found'); j.status = 'rejected'; j.step = 'Declined by you'; this.save(j); this.card(j); return j; }
  remove(id) { fs.rmSync(this.file(id), { force: true }); sessions.remove && sessions.remove(this.vault, 'fetch-' + id); this.broadcast({ type: 'fetcher' }); }

  // A Live/Agents card so the user can watch the team work, like any other agent.
  card(job) {
    const status = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : job.status === 'needs-approval' ? 'needs-you' : ['rejected'].includes(job.status) ? 'done' : 'working';
    try { sessions.upsert(this.vault, 'fetch-' + job.id, { agent: 'fetcher', title: `Fetcher: ${job.topic}`, status, step: job.step, project: job.project, launched: true, tool: 'fetcher' }); } catch { /* best effort */ }
  }

  step(job, text) { job.step = text; this.save(job); this.card(job); }

  start(id) {
    if (this.running.has(id) || !this.runner && !this.deps.ask) return; // processes without a runner only queue
    this.running.add(id);
    this.run(id).catch((e) => { const j = this.get(id); if (j) { j.status = 'error'; j.step = `Failed: ${e.message}`; this.save(j); this.card(j); } }).finally(() => this.running.delete(id));
  }

  async run(id) {
    const job = this.get(id);
    const c = this.conf();
    const search = this.deps.search || searchYouTube;
    const fetchVideo = this.deps.fetchVideo || ((vid) => media.fetchVideo(`https://www.youtube.com/watch?v=${vid}`));
    const ask = this.deps.ask || claudeAsker(this.runner, job.model);
    job.status = 'searching';

    // 1. search: several angles on the topic
    let found = [];
    for (const [i, q] of job.queries.entries()) {
      this.step(job, `Searching YouTube (${i + 1}/${job.queries.length}): "${q}"`);
      try { found = found.concat(await search(q, 10)); } catch (e) { job.searchErrors = [...(job.searchErrors || []), `${q}: ${e.message}`]; }
    }
    const ranked = rankCandidates(found, job.topic);
    job.found = ranked.length;
    if (!ranked.length) throw new Error(`No videos found${job.searchErrors ? ` (${job.searchErrors[0]})` : ''}`);

    // 2. transcripts for the best-ranked, then the free pre-check
    job.status = 'checking';
    const pool = ranked.slice(0, Math.min(16, job.maxVideos * 2));
    const fetched = [];
    // YouTube answers "429 Too Many Requests" to bursts of caption downloads: two at a time, and wait + retry on 429.
    const getInfo = async (vid) => {
      let info = {};
      for (let attempt = 0; attempt < 3; attempt++) {
        try { info = await fetchVideo(vid); } catch (e) { info = { note: e.message }; }
        if (info.transcript || !/\b429\b|too many requests/i.test(String(info.note || ''))) return info;
        await new Promise((r) => setTimeout(r, (this.deps.retryMs ?? 5000) * (attempt + 1)));
      }
      return info;
    };
    await pmap(pool, 2, async (cand, i) => {
      this.step(job, `Reading video ${i + 1}/${pool.length}: ${clip(cand.title, 60)}`);
      const info = await getInfo(cand.id);
      const v = { ...cand, channel: cand.channel || info.channel, duration: cand.duration || info.duration, description: clip(info.description, 2000), transcript: info.transcript || '', transcriptNote: info.note };
      v.pre = preCheck(v, job.topic);
      fetched.push(v);
    });
    fetched.sort((a, b) => b.pre.score - a.pre.score || b.rank - a.rank);
    const shortlist = fetched.filter((v) => v.pre.score >= 25).slice(0, job.maxVideos);
    const shortSet = new Set(shortlist.map((v) => v.id));
    const why = (v) => (!v.pre.transcript ? 'no transcript' : v.pre.score < 25 ? 'pre-check too low' : `not in the top ${job.maxVideos}`);
    job.videos = fetched.map((v) => ({ id: v.id, title: v.title, channel: v.channel, duration: v.duration, views: v.views, rank: v.rank, pre: v.pre, transcriptNote: v.transcript ? undefined : v.transcriptNote, ...(shortSet.has(v.id) ? {} : { skipped: why(v) }) }));
    if (!shortlist.length) {
      job.status = 'done';
      this.step(job, `Done: none of ${fetched.length} videos passed the pre-check${fetched.some((v) => !v.pre.transcript) ? ' (transcripts missing: install yt-dlp)' : ''}`);
      this.writeReport(job);
      return job;
    }

    // 3. usefulness checker: a small team of reviewers in parallel, one video each
    job.status = 'reviewing';
    let done = 0;
    await pmap(shortlist, Math.max(1, Math.min(4, c.team)), async (v) => {
      const slot = job.videos.find((x) => x.id === v.id);
      try {
        const r = await ask(REVIEW_INSTRUCTION, reviewInput(job, v));
        const review = parseReview(r.text);
        Object.assign(slot, { review, ...worth(review, job.threshold) });
        if (r.usage) { job.usage.input += r.usage.input || 0; job.usage.output += r.usage.output || 0; }
        job.usage.cost += r.cost || 0;
      } catch (e) { slot.error = clip(e.message, 300); }
      done++;
      this.step(job, `Usefulness checker: ${done}/${shortlist.length} videos reviewed`);
    });

    // 4. teach + verify agents can find it
    job.status = 'teaching';
    const lesson = teach(this.store, job);
    if (lesson) { job.lesson = lesson; job.learning = recallCheck(this.store, job, lesson.id); }
    job.status = 'done';
    const worthIt = job.videos.filter((v) => v.verdict === 'worth it').length;
    this.step(job, lesson ? `Done: ${worthIt} worth-it video${worthIt === 1 ? '' : 's'} → ${lesson.techniques} technique${lesson.techniques === 1 ? '' : 's'} taught in "${lessonTitle(job.topic)}"` : `Done: no video was worth it (${job.videos.filter((v) => v.review).length} reviewed)`);
    this.writeReport(job);
    this.store.log({ agent: 'fetcher', action: 'fetcher.done', summary: `Researched "${job.topic}": ${job.videos.length} videos checked, ${worthIt} worth it${lesson ? `, taught ${lesson.techniques} techniques` : ''}`, project: job.project, ref: lesson && lesson.id });
    return job;
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
    job.step = `Re-scored at ${job.threshold}: ${n} worth it${lesson ? ` → ${lesson.techniques} techniques in "${lessonTitle(job.topic)}"` : ''}`;
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
  try { const techs = JSON.parse(rec.meta.fetcher_lesson || '[]'); if (techs.length) return clip(`LESSON (vetted, ${techs.length} techniques): ${takeaways(techs, 4).join(' | ')}`, max); } catch { /* fall through */ }
  return '';
}

module.exports = { lessonPreview, takeaways, __claudeAsker: claudeAsker, __reviewInput: reviewInput, Fetcher, buildQueries, parseSearchPage, rankCandidates, preCheck, excerpt, parseReview, worth, teach, recallCheck, lessonTitle, REVIEW_INSTRUCTION, searchYouTube };
