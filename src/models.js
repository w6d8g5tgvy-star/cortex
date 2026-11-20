'use strict';
// Which model is an agent using? Every task, run and chat in Cortex should say.
//  - Claude Code writes the model on every assistant line of its session log (transcript_path).
//  - Codex writes it to ~/.codex/sessions/**/rollout-*.jsonl ("model":"…").
//  - Apps connected over MCP (claude.ai, desktop, ChatGPT…) have no protocol field for it, so they say it
//    themselves: the optional `model` argument on Cortex tools (remembered for the session).
const fs = require('fs');
const os = require('os');
const path = require('path');

/** A safe, short model name (or undefined). */
function cleanModelName(m) {
  const s = String(m || '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 80 || /^(unknown|default|n\/a|none)$/i.test(s) || s.startsWith('<')) return undefined;
  return /^[\w .:\-/()[\]@+]+$/.test(s) ? s : undefined;
}

function tail(file, bytes = 256 * 1024) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Latest model in a Claude Code session log (reads only the end of the file). */
function claudeModelFromTranscript(file) {
  try {
    if (!file || !fs.existsSync(file)) return undefined;
    const ms = [...tail(file).matchAll(/"type":"assistant"[^\n]*?"model":"([^"]+)"/g)].map((m) => m[1]).filter((m) => !m.startsWith('<'));
    return cleanModelName(ms[ms.length - 1]);
  } catch { return undefined; }
}

/** Model Codex used in a run that started at `sinceMs` (newest rollout log written after it). */
function codexModelSince(sinceMs, home = os.homedir()) {
  try {
    const root = path.join(home, '.codex', 'sessions');
    const files = [];
    const walk = (d, depth) => {
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (/^rollout-.*\.jsonl$/.test(e.name)) { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs - 5000) files.push({ p, t: st.mtimeMs }); }
      }
    };
    walk(root, 0);
    files.sort((a, b) => b.t - a.t);
    for (const f of files) { const m = tail(f.p).match(/"model":"([^"]+)"/); if (m) return cleanModelName(m[1]); }
  } catch { /* no codex logs */ }
  return undefined;
}

/** Codex's configured default model (~/.codex/config.toml), if set. */
function codexDefaultModel(home = os.homedir()) {
  try { const m = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m); return m ? cleanModelName(m[1]) : undefined; } catch { return undefined; }
}

module.exports = { cleanModelName, claudeModelFromTranscript, codexModelSince, codexDefaultModel };
