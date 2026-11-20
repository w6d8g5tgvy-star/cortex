'use strict';
// AI tool usage read from the tools' own local logs, so it also counts work done outside Cortex.
// - Claude Code: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/**/*.jsonl, assistant lines carry message.usage.
// - Codex: <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst), token_count events carry
//   cumulative token totals and the account's rate limits (used percent, window, reset time).
// Only numbers are kept: no prompts, replies, paths or file names leave this module.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const HOUR = 36e5;
const WINDOWS = { h5: 5 * HOUR, d1: 24 * HOUR, d7: 7 * 24 * HOUR };
const MAX_FILE = 200 * 1024 * 1024; // skip absurdly large logs instead of blocking the server
const cache = new Map(); // file -> { key, entries, limits }
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function homes(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return {
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
  };
}

// Recursively list log files changed since `since`. Depth-limited; never follows symlinks.
function listLogs(dir, test, since, depth = 0, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && depth < 5) listLogs(f, test, since, depth + 1, out);
    else if (e.isFile() && test(e.name)) {
      try { const st = fs.statSync(f); if (st.mtimeMs >= since && st.size <= MAX_FILE) out.push({ f, st }); } catch { /* vanished */ }
    }
  }
  return out;
}

function readText(f) {
  let b = fs.readFileSync(f);
  if (f.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return null; // Node < 22.15 cannot read compressed Codex logs
    b = zlib.zstdDecompressSync(b);
  }
  return b.toString('utf8');
}

// Parse once per (size, mtime); later scans reuse the cached numbers.
function cached(f, st, parse) {
  const key = st.size + ':' + st.mtimeMs;
  const hit = cache.get(f);
  if (hit && hit.key === key) return hit;
  let res = { entries: [], limits: null, unreadable: false };
  try {
    const text = readText(f);
    if (text == null) res.unreadable = true; else res = { ...parse(text), unreadable: false };
  } catch { res.unreadable = true; }
  const val = { key, ...res };
  cache.set(f, val);
  return val;
}

function parseClaude(text) {
  const entries = []; const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const u = o && o.message && o.message.usage;
    if (o.type !== 'assistant' || !u) continue;
    // Claude Code writes one line per content block with the same message id and usage: count it once.
    const id = (o.message.id || '') + '|' + (o.requestId || '');
    if (id !== '|' && seen.has(id)) continue;
    seen.add(id);
    const t = Date.parse(o.timestamp);
    if (!t) continue;
    entries.push({ t, input: n(u.input_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens), output: n(u.output_tokens), model: String(o.message.model || '').slice(0, 60) });
  }
  return { entries, limits: null };
}

function parseCodex(text) {
  const entries = []; let prev = null; let limits = null;
  for (const line of text.split('\n')) {
    if (!line.includes('token_count')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o && o.payload;
    if (!p || p.type !== 'token_count') continue;
    const t = Date.parse(o.timestamp) || 0;
    const rl = p.rate_limits;
    if (rl && (rl.primary || rl.secondary) && (!limits || t >= limits.t)) limits = { t, raw: rl };
    const tot = p.info && p.info.total_token_usage;
    if (!tot || !t) continue;
    // Totals are cumulative per session: count only the growth since the previous event.
    const cur = { input: n(tot.input_tokens), cacheRead: n(tot.cached_input_tokens), output: n(tot.output_tokens) };
    const d = prev ? { input: cur.input - prev.input, cacheRead: cur.cacheRead - prev.cacheRead, output: cur.output - prev.output } : cur;
    prev = cur;
    if (d.input < 0 || d.output < 0) continue; // counter reset: skip rather than go negative
    if (d.input || d.output) entries.push({ t, input: d.input - Math.min(d.input, n(d.cacheRead)), cacheRead: n(d.cacheRead), cacheWrite: 0, output: d.output, model: '' });
  }
  return { entries, limits };
}

function limitView(l, now) {
  if (!l) return null;
  const win = (w) => {
    if (!w || !Number.isFinite(w.used_percent)) return null;
    const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
    const reset = resetsAt != null && resetsAt <= now;
    return { usedPercent: reset ? 0 : Math.max(0, Math.min(100, w.used_percent)), windowMinutes: n(w.window_minutes) || null, resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null, resetSinceCheck: reset };
  };
  return { checkedAt: new Date(l.t).toISOString(), plan: typeof l.raw.plan_type === 'string' ? l.raw.plan_type.slice(0, 30) : null, primary: win(l.raw.primary), secondary: win(l.raw.secondary), limitReached: !!l.raw.rate_limit_reached_type };
}

function summarise(entries, now) {
  const out = {};
  for (const [k, ms] of Object.entries(WINDOWS)) out[k] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0 };
  let last = 0; const models = {};
  for (const e of entries) {
    if (e.t > last) last = e.t;
    for (const [k, ms] of Object.entries(WINDOWS)) {
      if (e.t < now - ms) continue;
      const w = out[k];
      w.input += e.input; w.cacheRead += e.cacheRead; w.cacheWrite += e.cacheWrite; w.output += e.output; w.calls++;
      w.total += e.input + e.cacheRead + e.cacheWrite + e.output;
    }
    if (e.model && e.t >= now - WINDOWS.d1) models[e.model] = (models[e.model] || 0) + e.input + e.cacheRead + e.cacheWrite + e.output;
  }
  return { windows: out, lastActivity: last ? new Date(last).toISOString() : null, models };
}

/** Scan both tools' logs. Cheap on repeat calls: unchanged files are not re-read. */
function scan({ env = process.env, now = Date.now() } = {}) {
  const t0 = Date.now();
  const h = homes(env);
  const since = now - WINDOWS.d7;
  const result = {};
  const tools = {
    claude: { label: 'Claude Code', dir: path.join(h.claude, 'projects'), test: (x) => x.endsWith('.jsonl'), parse: parseClaude },
    codex: { label: 'Codex', dir: path.join(h.codex, 'sessions'), test: (x) => /^rollout-.*\.jsonl(\.zst)?$/.test(x), parse: parseCodex },
  };
  const live = new Set();
  for (const [k, tool] of Object.entries(tools)) {
    const files = listLogs(tool.dir, tool.test, since);
    const found = fs.existsSync(tool.dir);
    let entries = []; let limits = null; let unreadable = 0;
    for (const { f, st } of files) {
      live.add(f);
      const c = cached(f, st, tool.parse);
      if (c.unreadable) { unreadable++; continue; }
      entries = entries.concat(c.entries);
      if (c.limits && (!limits || c.limits.t >= limits.t)) limits = c.limits;
    }
    result[k] = { label: tool.label, found, files: files.length, unreadable, ...summarise(entries, now), limits: limitView(limits, now) };
  }
  for (const f of cache.keys()) if (!live.has(f)) cache.delete(f); // forget logs that aged out
  result.scannedAt = new Date(now).toISOString();
  result.scanMs = Date.now() - t0;
  return result;
}

/**
 * Claude Code writes no quota numbers to its logs, but a run that hits a limit ends with a message such as
 * "You've hit your 5-hour limit · resets 4:10pm". Surface those from recent Cortex runs (last 24 hours).
 */
function limitNotices(sessionList, now = Date.now()) {
  return (sessionList || [])
    .filter((s) => s && s.status === 'error' && /(hit your|usage|rate)[^.\n]{0,40}limit/i.test(String(s.step || '')) && Date.parse(s.updated) >= now - WINDOWS.d1)
    .map((s) => ({ agent: s.agent, tool: s.tool, message: String(s.step).slice(0, 200), at: s.updated }))
    .slice(0, 5);
}

/** Usage report for the dashboard and agents: token totals per window, Codex quota, recent limit hits. */
function report(sessionList, opts) {
  return { ...scan(opts), notices: limitNotices(sessionList, opts && opts.now) };
}

module.exports = { scan, report, limitNotices, parseClaude, parseCodex, homes, WINDOWS };
