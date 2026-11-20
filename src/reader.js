'use strict';
// Reads a YouTube video the way a careful person would, not just its transcript:
//   speech     — captions (creator subtitles preferred over auto), rolling duplicates merged, filler and caption
//                junk removed (conservatively), commonly misheard technical terms corrected using a glossary
//                built from the video's own title, description, chapters and tags plus the research vocabulary
//   structure  — chapters (from YouTube or "00:00 Intro" lines in the description)
//   the screen — a few frames grabbed with ffmpeg where the speaker points at something ("as you can see",
//                "type this", "on screen") and at chapter starts, for the reviewer to look at
//   the page   — description, tags, likes/views/date, and up to 2 relevant linked pages (docs, repos, posts)
//   viewers    — top comments (corrections, "this is outdated", better ways)
// Research behind these choices is summarised in the Fetcher notes in Cortex.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const media = require('./media');

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const run = (bin, args, timeout = 120000) => new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 128 * 1024 * 1024, windowsHide: true, env: media.toolEnv() }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').pop().slice(0, 300))) : resolve(out))));

// ---------- speech ----------
/** YouTube auto-captions roll: each cue repeats the end of the previous one. Keep only the new words. */
function dedupeCues(cues) {
  const out = [];
  let prev = '';
  for (const c of cues || []) {
    let t = String(c.text || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (prev && (prev === t || prev.endsWith(t))) continue;
    const pw = prev.split(' '); const tw = t.split(' ');
    let k = Math.min(pw.length, tw.length);
    for (; k >= 3; k--) if (pw.slice(-k).join(' ').toLowerCase() === tw.slice(0, k).join(' ').toLowerCase()) break;
    if (k >= 3) t = tw.slice(k).join(' ');
    if (!t) continue;
    out.push({ ...c, text: t });
    prev = String(c.text || '').replace(/\s+/g, ' ').trim();
  }
  return out;
}

// Conservative on purpose: "like" and "you know" often carry meaning, so only clear fillers and caption tags go.
const NOISE = /\[(?:music|applause|laughter|laughs|inaudible|silence|foreign|__|sound|noise)\]|♪+|>>+/gi;
const FILLER = /(^|[\s,])(?:u+m+|u+h+|uhm+|e+rm+|hmm+|mm+hmm)(?=[\s,.!?]|$)[,]?/gi;
const STUTTER = /\b([a-z']{1,12})(?:\s+\1\b){1,3}/gi;
function cleanSpeech(text) {
  return String(text || '').split('\n').map((line) => {
    const m = line.match(/^(\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(.*)$/);
    let body = (m[2] || '').replace(NOISE, ' ').replace(FILLER, '$1').replace(STUTTER, '$1').replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    body = body.replace(/^,\s*/, '');
    return (m[1] || '') + body;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Technical words speech recognition often gets wrong. `needs`: only fix when the video is about that subject,
// so a real "cloud code" talk isn't turned into "Claude Code".
const MISHEARD = [
  { re: /\b(?:cloud|clawed|clod|claud)\s+code\b/gi, to: 'Claude Code', needs: /claude|anthropic/i },
  { re: /\b(?:clawed|clod|claud)\b/gi, to: 'Claude', needs: /claude|anthropic/i },
  { re: /\bcloud\b(?=\s+(?:opus|sonnet|haiku|desktop|\.ai|ai\b|projects?\b|artifacts?))/gi, to: 'Claude', needs: /claude|anthropic/i },
  { re: /\banthropics?\b/gi, to: 'Anthropic' },
  { re: /\bchat\s*g\.?\s*p\.?\s*t\b/gi, to: 'ChatGPT' },
  { re: /\b(?:chachi|chatty|chatchi|chat\s*cheap?)\s*p\.?\s*t\b/gi, to: 'ChatGPT', needs: /chatgpt|openai|gpt|llm/i },
  { re: /\bclaude\s*md\b|\bcloud\s*(?:\.|dot)?\s*md\b/gi, to: 'CLAUDE.md', needs: /claude/i },
  { re: /\bagents?\s*(?:\.|dot)\s*md\b/gi, to: 'AGENTS.md' },
  { re: /\bopen\s*a\.?\s*i\b/gi, to: 'OpenAI' },
  { re: /\bget\s*hub\b|\bgit\s+hub\b/gi, to: 'GitHub' },
  { re: /\bco-?pilot\b/gi, to: 'Copilot' },
  { re: /\b(?:m\.?\s?c\.?\s?p|emcee\s*p)\b/gi, to: 'MCP' },
  { re: /\bl\.?\s?l\.?\s?m(s)?\b/gi, to: 'LLM$1' },
  { re: /\bv\.?\s?s\.?\s+code\b/gi, to: 'VS Code' },
  { re: /\bnode\s*js\b|\bnode\s+j\.?\s?s\b/gi, to: 'Node.js' },
  { re: /\bjava\s+script\b/gi, to: 'JavaScript' },
  { re: /\btype\s+script\b/gi, to: 'TypeScript' },
  { re: /\bapi\b/g, to: 'API' },
  { re: /\bcodecs\b(?=\s+(?:cli|exec|agent|app))/gi, to: 'Codex', needs: /codex|openai/i },
];

/** Proper names and terms from the video's own metadata plus the research vocabulary: the "correct spellings" list. */
const COMMON = /^(The|This|That|And|But|For|You|Your|How|What|Why|When|Here|There|With|From|Just|Link|Links|Video|Videos|Subscribe|Chapters|Timestamps|Intro|Outro|Today|Watch|Is|Are|Was|Use|Using|Best|New|Free|Fix|Built|Real|Final|Should|Worth|Does|Did|Can|Will|My|Our|All|More|Less|Top|Get|Make|Stop|Start|Why|Who)$/;
function buildGlossary({ title, description, chapters, tags, vocab } = {}) {
  const desc = String(description || '').slice(0, 4000);
  const descLow = desc.toLowerCase();
  const tagLow = (tags || []).map((t) => String(t).toLowerCase());
  const found = new Set();
  const add = (w) => { w = String(w).trim(); if (w.length >= 3 && !COMMON.test(w)) found.add(w); };
  // Names that are clearly names: acronyms (MCP, LLM), mixed case (TokenEconomizer, ChatGPT), tags, vocabulary.
  for (const src of [title, desc, ...(chapters || []).map((c) => c.title)]) {
    for (const m of String(src || '').matchAll(/\b([A-Z]{2,}[a-z]*s?|[A-Za-z]+[a-z][A-Z][A-Za-z]*|[A-Z][a-z]+[A-Z][A-Za-z]*)\b/g)) add(m[1]);
  }
  // Title-case phrases ("Claude Code") only when the description or tags use the same phrase too, so a headline
  // like "Claude Code Is Wasting Tokens" doesn't become a "name".
  for (const src of [title, ...(chapters || []).map((c) => c.title)]) {
    for (const m of String(src || '').matchAll(/\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,2})\b/g)) {
      const words = m[1].split(/\s+/);
      for (let n = words.length; n >= 2; n--) for (let i = 0; i + n <= words.length; i++) {
        const p = words.slice(i, i + n).join(' ');
        if (COMMON.test(words[i]) || COMMON.test(words[i + n - 1])) continue;
        if (descLow.includes(p.toLowerCase()) || tagLow.includes(p.toLowerCase())) add(p);
      }
    }
  }
  for (const t of tags || []) if (/[A-Z]/.test(t) || /\s/.test(t)) add(t);
  for (const v of vocab || []) if (v && /[A-Za-z]/.test(v)) add(v);
  // One spelling per name, preferring the one with capitals ("Claude Code" over a lowercase tag "claude code").
  const best = new Map();
  for (const w of found) { const k = w.toLowerCase(); const cur = best.get(k); if (!cur || (w.match(/[A-Z]/g) || []).length > (cur.match(/[A-Z]/g) || []).length) best.set(k, w); }
  return [...best.values()].slice(0, 50);
}

/** Fix misheard technical terms and the capitalisation of glossary terms. Returns { text, fixes }. */
function correctTerms(text, glossary = [], context = '') {
  let out = String(text || '');
  const ctx = `${context} ${glossary.join(' ')}`;
  let fixes = 0;
  for (const r of MISHEARD) {
    if (r.needs && !r.needs.test(ctx)) continue;
    out = out.replace(r.re, (...a) => { fixes++; return r.to.replace('$1', a[1] || ''); });
  }
  for (const g of glossary) {
    if (!/[A-Z]/.test(g) || !/\s|[A-Z].*[A-Z]|[a-z][A-Z]/.test(g) || g.length < 4) continue; // only capitalised multi-word or mixed-case names
    // Speech recognition splits product names ("Token Economizer" for TokenEconomizer): allow a gap at each
    // word or case boundary of the name.
    const pattern = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?[ .-]/g, '[ .-]?').replace(/([a-z])(?=[A-Z])/g, '$1[ .-]?');
    const re = new RegExp(`\\b${pattern}\\b`, 'gi');
    out = out.replace(re, (m) => { if (m !== g) fixes++; return g; });
  }
  return { text: out, fixes };
}

// ---------- structure ----------
function chaptersFrom(info, description) {
  if (Array.isArray(info && info.chapters) && info.chapters.length) return info.chapters.map((c) => ({ start: Math.round(c.start_time || 0), title: clip(c.title, 100) }));
  const out = [];
  for (const line of String(description || '').split('\n')) {
    const m = line.match(/^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|]?\s*(.{2,100})$/);
    if (m) { const p = m[1].split(':').map(Number); out.push({ start: p.reduce((a, b) => a * 60 + b, 0), title: clip(m[2], 100) }); }
  }
  return out.length >= 2 && out[0].start === 0 ? out : [];
}

// ---------- the screen ----------
const VISUAL = /\b(as you can see|you can see|on (?:the|my) screen|look at (?:this|that|the)|right here|over here|this (?:command|code|file|setting|line|prompt|config|folder|output|error|diagram)|type (?:in|this|out)|paste|copy (?:this|that)|click|in the terminal|in the code|let me show|here's (?:the|my|what)|run this|you'll see)\b/i;
const tsToSec = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

/** Moments worth looking at: where the speaker points at the screen (most relevant first) and chapter starts. */
function pickFrameTimes(transcript, { chapters = [], duration = 0, vocab = [], max = 6 } = {}) {
  const cands = [];
  for (const line of String(transcript || '').split(/\n+/)) {
    const m = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
    if (!m) continue;
    const start = tsToSec(m[1]);
    for (const s of m[2].split(/(?<=[.!?])\s+/)) {
      if (!VISUAL.test(s)) continue;
      const low = s.toLowerCase();
      const rel = vocab.reduce((a, v) => a + (v && low.includes(String(v).toLowerCase()) ? 1 : 0), 0);
      // within a ~45-75 s paragraph, guess the sentence's moment by its position in the paragraph
      const pos = m[2].indexOf(s) / Math.max(1, m[2].length);
      cands.push({ t: Math.round(start + pos * 50 + 3), why: clip(s, 90), score: 2 + rel });
    }
  }
  for (const c of chapters.slice(1)) cands.push({ t: c.start + 8, why: `chapter: ${c.title}`, score: 1 + vocab.reduce((a, v) => a + (v && c.title.toLowerCase().includes(String(v).toLowerCase()) ? 1 : 0), 0) });
  const picked = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (duration && c.t >= duration - 2) continue;
    if (picked.some((p) => Math.abs(p.t - c.t) < 25)) continue;
    picked.push(c);
    if (picked.length >= max) break;
  }
  return picked.sort((a, b) => a.t - b.t);
}

async function grabFrames(url, times, dir, { ffmpeg, ytdlp }) {
  if (!times.length || !ffmpeg || !ytdlp) return [];
  // YouTube refuses ffmpeg's own requests (403), so yt-dlp downloads a 1-second ≤720p clip per moment (all in one
  // call, a few hundred KB in total), then ffmpeg takes one frame from each clip. 720p is enough to read code.
  fs.mkdirSync(dir, { recursive: true });
  const sections = times.flatMap((f) => ['--download-sections', `*${f.t}-${f.t + 1}`]);
  await run(ytdlp, ['--no-warnings', '-q', '--no-playlist', '-f', 'bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]', ...sections,
    '--ffmpeg-location', path.dirname(ffmpeg), '-o', path.join(dir, 'clip-%(section_start)s.%(ext)s'), url], 240000);
  const out = [];
  for (const f of times) {
    const clipFile = fs.readdirSync(dir).find((n) => n.startsWith(`clip-${f.t}.`) || n.startsWith(`clip-${f.t}.0`));
    if (!clipFile) continue;
    const file = path.join(dir, `frame-${String(f.t).padStart(5, '0')}.jpg`);
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path.join(dir, clipFile), '-frames:v', '1', '-q:v', '4', '-y', file], 30000);
      if (fs.existsSync(file) && fs.statSync(file).size > 2000) out.push({ t: f.t, at: media.ts(f.t), why: f.why, file });
    } catch { /* skip this frame */ }
    fs.rm(path.join(dir, clipFile), { force: true }, () => {});
  }
  return out;
}

// ---------- the page: links ----------
const SKIP_LINK = /(?:^|\.)(?:instagram|facebook|tiktok|twitter|x|threads|discord|patreon|ko-fi|buymeacoffee|linktr|amazon|amzn|bit|tinyurl|t|youtube|youtu|linkedin|gumroad|skool|stan)\.(?:com|be|co|ee|ly|gg|io|store)$/i;
const AFFILIATE = /[?&](?:ref|aff|affiliate|via|coupon|utm_campaign)=|\/(?:ref|aff|go|deal|sponsor)\//i;
/** Description links worth reading: docs, repos and posts about the topic, never social, shop or sponsor links. */
function pickLinks(description, vocab = [], max = 2) {
  const seen = new Set();
  const out = [];
  for (const line of String(description || '').split('\n')) {
    for (const m of line.matchAll(/https?:\/\/[^\s<>()"']+/g)) {
      const raw = m[0].replace(/[.,;:!?)\]]+$/, '');
      let u; try { u = new URL(raw); } catch { continue; }
      const host = u.hostname.replace(/^www\./, '');
      if (seen.has(u.href) || SKIP_LINK.test(host) || AFFILIATE.test(u.href) || /sponsor|discount|% off|promo/i.test(line)) continue;
      seen.add(u.href);
      const text = `${line} ${u.href}`.toLowerCase();
      const rel = vocab.reduce((a, v) => a + (v && text.includes(String(v).toLowerCase()) ? 1 : 0), 0);
      const kind = /github\.com|gitlab\.com/.test(host) ? 2 : /docs\.|\/docs?\/|readme|\.dev$|developer|learn\./.test(u.href) ? 2 : /blog|medium\.com|substack|dev\.to|hashnode/.test(u.href) ? 1 : 0;
      if (rel + kind === 0) continue;
      out.push({ url: u.href, line: clip(line.replace(raw, ''), 100), score: rel * 2 + kind });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

// ---------- viewers ----------
/** The most-liked comments (and the creator's own), which often correct the video or say it's outdated. */
function topComments(comments, max = 10) {
  return (comments || []).filter((c) => c && c.text && String(c.text).length > 15 && (!c.parent || c.parent === 'root'))
    .sort((a, b) => (!!b.is_pinned - !!a.is_pinned) || (!!b.author_is_uploader - !!a.author_is_uploader) || (b.like_count || 0) - (a.like_count || 0))
    .slice(0, max).map((c) => ({ text: clip(c.text, 300), likes: c.like_count || 0, creator: !!c.author_is_uploader, pinned: !!c.is_pinned }));
}

// ---------- the whole read ----------
const ytInfo = async (ytdlp, url, comments) => JSON.parse(await run(ytdlp, ['-J', '--skip-download', '--no-playlist', '--no-warnings',
  ...(comments ? ['--write-comments', '--extractor-args', 'youtube:comment_sort=top;max_comments=40,40,0,0'] : []), url], comments ? 180000 : 120000));

/**
 * Read a video. Light read (pool): metadata, chapters, cleaned and corrected transcript.
 * Full read (shortlist, opts.full): plus top comments, relevant linked pages and screen frames.
 */
async function readVideo(id, opts = {}) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const vocab = opts.vocab || [];
  const ytdlp = opts.ytdlp !== undefined ? opts.ytdlp : (process.env.CORTEX_YTDLP || await media.which('yt-dlp'));
  const notes = [];
  let info = null;
  if (ytdlp) { try { info = await ytInfo(ytdlp, url, !!opts.full && opts.comments !== false); } catch (e) { notes.push(`yt-dlp: ${e.message}`); } }
  if (!info) {
    // No yt-dlp (or it failed): the basic path still gives title, description and sometimes captions.
    const v = await media.fetchVideo(url);
    const glossary = buildGlossary({ title: v.title, description: v.description, vocab });
    const fixed = correctTerms(cleanSpeech(v.transcript || ''), glossary, `${v.title} ${v.description}`);
    return { id, url, title: v.title, channel: v.channel, duration: v.duration, description: clip(v.description, 3000), tags: [], chapters: chaptersFrom(null, v.description), transcript: fixed.text, transcriptSource: v.transcript ? 'captions' : 'none', speechFixes: fixed.fixes, glossary, comments: [], links: [], frames: [], notes: [v.note, ...notes].filter(Boolean) };
  }
  const description = String(info.description || '');
  const chapters = chaptersFrom(info, description);
  const glossary = buildGlossary({ title: info.title, description, chapters, tags: info.tags, vocab });

  // captions: creator subtitles first, then auto-captions
  const tracks = [];
  for (const [src, auto] of [[info.subtitles, false], [info.automatic_captions, true]]) {
    for (const [lang, fmts] of Object.entries(src || {})) {
      const f = (fmts || []).find((x) => x.ext === 'json3') || (fmts || []).find((x) => x.ext === 'vtt') || (fmts || []).find((x) => /srv|ttml|xml/.test(x.ext));
      if (f && f.url && lang !== 'live_chat') tracks.push({ lang, auto, url: f.url });
    }
  }
  const track = media.pickTrack(tracks);
  let transcript = ''; let fixes = 0; let source = 'none';
  if (track) {
    for (let attempt = 0; attempt < 3 && !transcript; attempt++) {
      try {
        const raw = (await media.safeFetch(track.url, { accept: '*/*' })).text;
        const cues = dedupeCues(media.parseCaptions(raw));
        const fixed = correctTerms(cleanSpeech(media.formatTranscript(cues)), glossary, `${info.title} ${description}`);
        transcript = fixed.text; fixes = fixed.fixes; source = track.auto ? 'auto-captions' : 'subtitles';
      } catch (e) {
        if (!/\b429\b/.test(e.message)) { notes.push(`captions: ${e.message}`); break; }
        if (attempt === 2) notes.push('captions: YouTube rate-limited the caption download (HTTP 429)'); // lets the caller retry later
        else await new Promise((r) => setTimeout(r, (opts.retryMs ?? 4000) * (attempt + 1)));
      }
    }
  } else notes.push('This video has no captions or subtitles.');

  const dossier = {
    id, url, title: info.title, channel: info.channel || info.uploader, duration: info.duration, views: info.view_count, likes: info.like_count,
    uploaded: info.upload_date ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}` : undefined,
    description: clip(description, 3000), tags: (info.tags || []).slice(0, 20), chapters, transcript, transcriptSource: source, speechFixes: fixes, glossary,
    comments: [], links: [], frames: [], notes,
  };
  if (!opts.full) return dossier;

  dossier.comments = topComments(info.comments);
  for (const l of pickLinks(description, vocab)) {
    try { const a = await media.fetchArticle(l.url); dossier.links.push({ url: l.url, title: clip(a.title, 120), excerpt: clip(a.text, 1500) }); } catch (e) { notes.push(`link ${l.url}: ${e.message}`); }
  }
  if (opts.frames !== false && opts.framesDir) {
    const ffmpeg = opts.ffmpeg !== undefined ? opts.ffmpeg : await media.which('ffmpeg');
    const times = pickFrameTimes(transcript, { chapters, duration: info.duration, vocab, max: opts.maxFrames || 6 });
    try { dossier.frames = await grabFrames(url, times, opts.framesDir, { ffmpeg, ytdlp }); } catch (e) { notes.push(`frames: ${e.message}`); }
  }
  return dossier;
}

module.exports = { readVideo, dedupeCues, cleanSpeech, correctTerms, buildGlossary, chaptersFrom, pickFrameTimes, pickLinks, topComments, MISHEARD };
