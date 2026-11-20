'use strict';
// Fetch videos (metadata + transcript) and articles (readable text) for the Mind tab.
// AI can't literally watch a video: "watching" = title, channel, description and the transcript/captions.
// Order for videos: yt-dlp (if installed, supports most sites) → YouTube page captions → page metadata.
const dns = require('dns').promises;
const net = require('net');
const { execFile } = require('child_process');

const MAX_PAGE = 6 * 1024 * 1024;
const MAX_TEXT = 250000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---------- safe fetching (no localhost / private networks) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('Not a valid link'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links are supported');
  if (u.username || u.password) throw new Error('Links with passwords are not allowed');
  if (process.env.CORTEX_ALLOW_PRIVATE_FETCH === '1') return u; // tests only
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Local addresses are not allowed');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That link points to a private network address');
  return u;
}

async function safeFetch(url, { accept = 'text/html,application/xhtml+xml,*/*;q=0.8', headers = {}, max = MAX_PAGE, timeout = 20000 } = {}) {
  let current = String(url);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.8', ...headers } });
    } catch (e) { clearTimeout(t); throw new Error(e.name === 'AbortError' ? 'The site took too long to respond' : `Could not reach the site (${e.message})`); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(t);
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) { clearTimeout(t); throw new Error(`The site answered HTTP ${res.status}`); }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) { clearTimeout(t); throw new Error('The page is too large'); }
    const chunks = [];
    let size = 0;
    for await (const c of res.body) { size += c.length; if (size > max) { ctl.abort(); clearTimeout(t); throw new Error('The page is too large'); } chunks.push(c); }
    clearTimeout(t);
    return { url: current, type: res.headers.get('content-type') || '', text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

// ---------- HTML helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*>`, 'i');
    const tag = html.match(re);
    if (tag) { const c = tag[0].match(/content=["']([^"']*)["']/i); if (c) return decode(c[1]).trim(); }
  }
  return '';
}
function htmlToText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, '');
  const pick = (tag) => { const m = h.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return m && m[1].length > 500 ? m[1] : null; };
  h = pick('article') || pick('main') || (h.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, h])[1];
  h = h.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|figure)[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${'#'.repeat(Number(l) + 1)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  h = h.replace(/<li[^>]*>/gi, '\n- ').replace(/<(br|hr)\s*\/?>/gi, '\n').replace(/<\/(p|div|section|li|tr|blockquote|pre|ul|ol|table)>/gi, '\n\n');
  h = decode(h.replace(/<[^>]+>/g, ''));
  return h.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
}

async function fetchArticle(url) {
  const page = await safeFetch(url);
  if (/application\/pdf/i.test(page.type)) throw new Error('PDF links are not supported yet: download the PDF and paste its text into the item instead');
  if (/text\/(plain|markdown)/i.test(page.type)) return { title: url.split('/').pop() || url, text: page.text.slice(0, MAX_TEXT), url: page.url, method: 'plain text' };
  const html = page.text;
  const title = meta(html, ['og:title', 'twitter:title']) || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() || url;
  const text = htmlToText(html);
  if (text.length < 200) throw new Error('Could not find readable text on that page (it may need a login or JavaScript)');
  return {
    title, text, url: page.url, method: 'page text',
    author: meta(html, ['author', 'article:author', 'og:article:author']),
    published: meta(html, ['article:published_time', 'datePublished', 'date']),
    description: meta(html, ['og:description', 'description']),
    site: meta(html, ['og:site_name']) || new URL(page.url).hostname,
  };
}

// ---------- videos ----------
function youtubeId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      return m ? m[2] : null;
    }
  } catch { /* not a url */ }
  return null;
}

const ts = (sec) => { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0'); };

/** cues: [{start (s), text}] → readable paragraphs with a timestamp roughly every 45 s */
function formatTranscript(cues) {
  const out = [];
  let para = [];
  let paraStart = null;
  let last = '';
  for (const c of cues) {
    const t = decode(String(c.text || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!t || t === last) continue;
    last = t;
    if (paraStart === null) paraStart = c.start;
    para.push(t);
    if (c.start - paraStart >= 45 && /[.!?]$/.test(t) || c.start - paraStart >= 75) { out.push(`[${ts(paraStart)}] ${para.join(' ')}`); para = []; paraStart = null; }
  }
  if (para.length) out.push(`[${ts(paraStart || 0)}] ${para.join(' ')}`);
  return out.join('\n\n').slice(0, MAX_TEXT);
}

function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const m = b.match(/(\d+:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->/);
    if (!m) continue;
    const start = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const lines = b.split('\n').filter((l) => !l.includes('-->') && !/^\d+$/.test(l.trim()) && !/^(WEBVTT|NOTE|Kind:|Language:)/.test(l));
    cues.push({ start, text: lines.join(' ') });
  }
  return cues;
}
function parseJson3(text) {
  const j = JSON.parse(text);
  return (j.events || []).filter((e) => e.segs).map((e) => ({ start: (e.tStartMs || 0) / 1000, text: e.segs.map((s) => s.utf8 || '').join('') }));
}
function parseTimedXml(text) {
  const cues = [];
  const re = /<(?:text|p)[^>]*?(?:start|t)="([\d.]+)"[^>]*>([\s\S]*?)<\/(?:text|p)>/g;
  let m;
  while ((m = re.exec(text))) cues.push({ start: m[0].includes(' t="') ? Number(m[1]) / 1000 : Number(m[1]), text: m[2] });
  return cues;
}
function parseCaptions(text) {
  const t = text.trim();
  if (t.startsWith('{')) return parseJson3(t);
  if (t.startsWith('WEBVTT') || /-->/.test(t.slice(0, 500))) return parseVtt(t);
  return parseTimedXml(t);
}

function pickTrack(tracks, langs = ['en']) {
  if (!tracks || !tracks.length) return null;
  const by = (fn) => tracks.find(fn);
  return by((t) => langs.includes(t.lang) && !t.auto) || by((t) => langs.some((l) => t.lang.startsWith(l)) && !t.auto)
    || by((t) => langs.some((l) => t.lang.startsWith(l))) || by((t) => !t.auto) || tracks[0];
}

// Windows: programs installed after Cortex started (e.g. `winget install yt-dlp`) are only on the PATH saved in
// the registry, not on this process's PATH. Re-read it (cached 30 s) so tools and their helpers (yt-dlp → deno) are found.
let pathCache = { at: 0, value: '' };
function freshPath() {
  if (process.platform !== 'win32') return process.env.PATH || '';
  if (Date.now() - pathCache.at < 30000) return pathCache.value;
  const read = (key) => {
    try {
      const out = require('child_process').execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      return m ? m[1].trim().replace(/%([^%]+)%/g, (x, v) => process.env[v] || x) : '';
    } catch { return ''; }
  };
  const parts = [process.env.PATH || process.env.Path || '', read('HKCU\\Environment'), read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')]
    .join(';').split(';').map((s) => s.trim()).filter(Boolean);
  pathCache = { at: Date.now(), value: [...new Set(parts)].join(';') };
  return pathCache.value;
}
const toolEnv = () => (process.platform === 'win32' ? { ...process.env, PATH: freshPath(), Path: freshPath() } : process.env);

const which = (bin) => new Promise((res) => execFile(process.platform === 'win32' ? 'where' : 'which', [bin], { env: toolEnv(), windowsHide: true }, (e, out) => res(e ? null : String(out).split(/\r?\n/)[0].trim() || null)));

async function viaYtDlp(url) {
  const bin = process.env.CORTEX_YTDLP || await which('yt-dlp');
  if (!bin) return null;
  await assertPublicUrl(url);
  const args = ['-J', '--skip-download', '--no-playlist', '--no-warnings', url];
  const nodeWrapper = bin === process.env.CORTEX_YTDLP && /\.js$/i.test(bin);
  const json = await new Promise((resolve, reject) => execFile(nodeWrapper ? process.execPath : bin, nodeWrapper ? [bin, ...args] : args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: toolEnv() },
    (e, out, err) => (e ? reject(new Error(`yt-dlp: ${String(err || e.message).trim().split('\n').pop()}`)) : resolve(out))));
  const info = JSON.parse(json);
  const tracks = [];
  for (const [src, auto] of [[info.subtitles, false], [info.automatic_captions, true]]) {
    for (const [lang, fmts] of Object.entries(src || {})) {
      const f = (fmts || []).find((x) => x.ext === 'json3') || (fmts || []).find((x) => x.ext === 'vtt') || (fmts || []).find((x) => /srv|ttml|xml/.test(x.ext));
      if (f && f.url && lang !== 'live_chat') tracks.push({ lang, auto, url: f.url });
    }
  }
  const track = pickTrack(tracks);
  let transcript = '';
  let note = '';
  if (track) {
    try { transcript = formatTranscript(parseCaptions((await safeFetch(track.url, { accept: '*/*' })).text)); } catch (e) { note = `Captions found but could not be downloaded: ${e.message}`; }
  } else note = 'This video has no captions or subtitles.';
  return {
    method: 'yt-dlp', title: info.title, channel: info.uploader || info.channel, duration: info.duration, published: info.upload_date,
    description: String(info.description || '').slice(0, 5000), transcript, transcriptLang: track && `${track.lang}${track.auto ? ' (auto-generated)' : ''}`, note, url: info.webpage_url || url,
  };
}

function extractJsonAfter(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < html.length; k++) {
    const ch = html[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, k + 1)); } catch { return null; } } }
  }
  return null;
}

async function viaYouTubePage(id) {
  const page = await safeFetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
  const pr = extractJsonAfter(page.text, 'ytInitialPlayerResponse');
  if (!pr || !pr.videoDetails) throw new Error('YouTube did not return video details (the video may be private, age-restricted or region-locked)');
  const d = pr.videoDetails;
  const raw = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || []).map((t) => ({ lang: t.languageCode, auto: t.kind === 'asr', url: t.baseUrl }));
  const track = pickTrack(raw);
  let transcript = '';
  let note = '';
  if (track) {
    try {
      const cap = await safeFetch(track.url + (track.url.includes('fmt=') ? '' : '&fmt=json3'), { accept: '*/*' });
      transcript = cap.text.trim() ? formatTranscript(parseCaptions(cap.text)) : '';
      if (!transcript) note = 'YouTube returned empty captions to Cortex. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) for reliable transcripts.';
    } catch (e) { note = `Captions could not be downloaded (${e.message}). Install yt-dlp for reliable transcripts.`; }
  } else note = 'This video has no captions.';
  return {
    method: 'youtube page', title: d.title, channel: d.author, duration: Number(d.lengthSeconds) || undefined,
    description: String(d.shortDescription || '').slice(0, 5000), transcript, transcriptLang: track && `${track.lang}${track.auto ? ' (auto-generated)' : ''}`, note, url: `https://www.youtube.com/watch?v=${id}`,
  };
}

async function viaPageMeta(url) {
  const page = await safeFetch(url);
  const h = page.text;
  return {
    method: 'page info only', url: page.url,
    title: meta(h, ['og:title', 'twitter:title']) || decode((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() || url,
    channel: meta(h, ['og:site_name', 'author']), description: meta(h, ['og:description', 'description', 'twitter:description']),
    transcript: '', note: 'Only the page title and description were available. Install yt-dlp to get transcripts from most video sites.',
  };
}

async function fetchVideo(url) {
  await assertPublicUrl(url);
  const errors = [];
  try { const r = await viaYtDlp(url); if (r) return r; } catch (e) { errors.push(e.message); }
  const id = youtubeId(url);
  if (id) { try { return await viaYouTubePage(id); } catch (e) { errors.push(e.message); } }
  try { const r = await viaPageMeta(url); if (errors.length) r.note = `${r.note} (${errors.join('; ')})`; return r; } catch (e) { errors.push(e.message); }
  throw new Error(errors.join('; '));
}

/** Markdown body for a mind item from a fetch result. */
function videoMarkdown(v) {
  const dur = v.duration ? ` · ${ts(v.duration)}` : '';
  return [
    `**Channel:** ${v.channel || 'unknown'}${dur}${v.published ? ` · ${v.published}` : ''}  `,
    `**Source:** ${v.url} (fetched ${new Date().toISOString().slice(0, 16).replace('T', ' ')} via ${v.method})`,
    v.note ? `\n> ${v.note}` : '',
    v.description ? `\n## Description\n\n${v.description}` : '',
    `\n## Transcript${v.transcriptLang ? ` (${v.transcriptLang})` : ''}\n\n${v.transcript || '_No transcript available._'}`,
  ].join('\n');
}
function articleMarkdown(a) {
  return [
    `**Site:** ${a.site || ''}${a.author ? ` · **Author:** ${a.author}` : ''}${a.published ? ` · ${a.published.slice(0, 10)}` : ''}  `,
    `**Source:** ${a.url} (fetched ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
    a.description ? `\n> ${a.description}` : '',
    `\n## Article text\n\n${a.text}`,
  ].join('\n');
}

module.exports = { fetchVideo, fetchArticle, videoMarkdown, articleMarkdown, youtubeId, parseCaptions, formatTranscript, htmlToText, assertPublicUrl, isPrivateIp, safeFetch, extractJsonAfter, which, toolEnv };
