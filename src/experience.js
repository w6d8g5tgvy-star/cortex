'use strict';
// Experience digest: learn from the agents' own past work, for free (no AI calls).
// Reads notes/<project>/agent-journal.md (written by Cortex for every agent session) and finds:
//   - hot files (changed most often): what agents should read first
//   - fail → fix pairs: a failed session followed by a later success on the same files or request
//     (the "contrast successful vs failed attempts" signal from ExpeL / Agent Workflow Memory)
//   - recurring trouble words in failed sessions
//   - how often agents finish and how often they save what they learned
// The digest is stored as a project memory ("Experience digest: <project>") and a short version is
// added to the project brief, so every agent starts with what earlier sessions learned the hard way.
const fs = require('fs');
const journal = require('./journal');

const STOP = new Set('the and for are but not you all any can was one our out has have how its may new now see two who did get let say use with that this from they will what when your were been than them then into more some such only also just over very about would there their which could other after those these where while please make sure added fixed file files code test tests run ran using used work done made want need still into because'.split(' '));
const words = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])].filter((w) => !STOP.has(w));
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const FAIL_WORDS = /\b(fail(ed|s|ing)?|error|broke|broken|crash(ed)?|exception|not found|cannot|can't|couldn't|denied|timeout|timed out|blocked|wrong)\b/i;

/** Parse an agent journal into sessions (### blocks) and one-line actions. */
function parse(text) {
  const sessions = [];
  const actions = [];
  let date = '';
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^## (\d{4}-\d{2}-\d{2})\s*$/))) { date = m[1]; cur = null; continue; }
    if ((m = line.match(/^### (\d\d:\d\d) · (.+?) · (✓ finished|✗ failed|■ stopped)(?: \((.*)\))?\s*$/))) {
      cur = { date, time: m[1], agent: m[2].trim(), status: m[3].startsWith('✓') ? 'ok' : m[3].startsWith('✗') ? 'fail' : 'stopped', source: m[4] || '', asked: '', files: [], commands: 0, saved: null, outcome: '' };
      sessions.push(cur);
      continue;
    }
    if ((m = line.match(/^- (\d\d:\d\d) · \*\*(.+?)\*\* · (.*)$/))) { actions.push({ date, time: m[1], agent: m[2], summary: m[3] }); cur = null; continue; }
    if (!cur) continue;
    if ((m = line.match(/^\*\*Asked:\*\* (.*)$/))) cur.asked = m[1];
    else if ((m = line.match(/^\*\*Changed:\*\* (.*)$/))) cur.files = (m[1].match(/`([^`]+)`/g) || []).map((f) => f.slice(1, -1));
    else if ((m = line.match(/^\*\*Commands run:\*\* (\d+)/))) cur.commands = Number(m[1]);
    else if ((m = line.match(/^\*\*Saved to memory:\*\* (yes|no)/))) cur.saved = m[1] === 'yes';
    else if ((m = line.match(/^\*\*Outcome:\*\* (.*)$/))) cur.outcome = m[1];
    else if (cur.outcome && line.trim()) cur.outcome += ' ' + line.trim();
  }
  // a "finished" session whose outcome clearly reports a failure counts as a failure
  for (const s of sessions) if (s.status === 'ok' && FAIL_WORDS.test(s.outcome) && !/\b(fixed|resolved|now (works|passes)|passing|all .* pass)\b/i.test(s.outcome)) s.status = 'trouble';
  return { sessions, actions };
}

/** Build the digest for one project from its journal. */
function digest(store, project) {
  const f = journal.fileFor(store.vault, project);
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { /* no journal yet */ }
  const { sessions, actions } = parse(text);
  const n = sessions.length;
  const ok = sessions.filter((s) => s.status === 'ok').length;
  const bad = sessions.filter((s) => s.status === 'fail' || s.status === 'trouble');
  const savedKnown = sessions.filter((s) => s.saved !== null);
  const saved = savedKnown.filter((s) => s.saved).length;
  // hot files
  const fileCount = new Map();
  for (const s of sessions) for (const x of new Set(s.files)) fileCount.set(x, (fileCount.get(x) || 0) + 1);
  const hot = [...fileCount.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const troubleFiles = new Map();
  for (const s of bad) for (const x of new Set(s.files)) troubleFiles.set(x, (troubleFiles.get(x) || 0) + 1);
  // fail → fix pairs: a later success that shares files or most of the request
  const pairs = [];
  sessions.forEach((s, i) => {
    if (!(s.status === 'fail' || s.status === 'trouble')) return;
    const sw = words(s.asked + ' ' + s.outcome);
    for (const t of sessions.slice(i + 1, i + 12)) {
      if (t.status !== 'ok') continue;
      const shared = s.files.filter((x) => t.files.includes(x));
      const sim = jaccard(words(s.asked), words(t.asked));
      if (shared.length || sim >= 0.3) {
        pairs.push({ failed: s, fixed: t, shared, sim: Math.round(sim * 100), clue: words(t.outcome).filter((w) => !sw.includes(w)).slice(0, 8) });
        break;
      }
    }
  });
  // trouble words
  const tw = new Map();
  for (const s of bad) for (const w of words(s.outcome)) tw.set(w, (tw.get(w) || 0) + 1);
  const troubleWords = [...tw.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w, c]) => `${w} (${c})`);
  const agents = {};
  for (const s of sessions) { const a = (agents[s.agent] = agents[s.agent] || { sessions: 0, ok: 0, saved: 0 }); a.sessions++; if (s.status === 'ok') a.ok++; if (s.saved) a.saved++; }
  return { project, sessions: n, actions: actions.length, ok, trouble: bad.length, saved, savedKnown: savedKnown.length, hot, troubleFiles: [...troubleFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5), pairs: pairs.slice(-8), troubleWords, agents, last: sessions.length ? `${sessions[n - 1].date} ${sessions[n - 1].time}` : null };
}

function markdown(d, title) {
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  const L = [`# Experience digest: ${title}`, '', `Written automatically by Cortex from this project's agent journal (no AI used). Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. Agents: read this before starting work here.`, ''];
  if (!d.sessions) { L.push('No agent sessions recorded yet.'); return L.join('\n'); }
  L.push(`**${d.sessions} sessions** · ${pct(d.ok, d.sessions)} finished cleanly · ${d.trouble} hit trouble · saved what they learned in ${pct(d.saved, d.savedKnown)} of sessions${d.last ? ` · last ${d.last}` : ''}`, '');
  if (d.hot.length) L.push('## Files agents change most (read these first)', ...d.hot.map(([f, c]) => `- \`${f}\`: changed in ${c} sessions${d.troubleFiles.some(([x]) => x === f) ? ' ⚠ involved in trouble' : ''}`), '');
  if (d.pairs.length) {
    L.push('## Fail → fix pairs (learn from these)');
    for (const p of d.pairs) {
      L.push(`- **Trouble** (${p.failed.date} ${p.failed.time}, ${p.failed.agent}): ${clip(p.failed.asked, 120)} → ${clip(p.failed.outcome, 180)}`);
      L.push(`  **Fixed** (${p.fixed.date} ${p.fixed.time}, ${p.fixed.agent}): ${clip(p.fixed.outcome, 220)}${p.shared.length ? ` · same files: ${p.shared.slice(0, 4).map((x) => '`' + x + '`').join(', ')}` : ''}`);
    }
    L.push('');
  }
  if (d.troubleWords.length) L.push('## Recurring trouble words', d.troubleWords.join(' · '), '');
  if (d.savedKnown && d.saved / d.savedKnown < 0.5) L.push('## Gap', `Agents saved what they learned in only ${pct(d.saved, d.savedKnown)} of sessions. Save decisions and gotchas with memory_write before finishing.`, '');
  L.push('## By agent', ...Object.entries(d.agents).map(([a, x]) => `- **${a}**: ${x.sessions} sessions, ${pct(x.ok, x.sessions)} clean, saved ${x.saved}`));
  return L.join('\n');
}

/** Short version for the agent brief (kept small to save tokens). */
function briefLines(d) {
  if (!d || !d.sessions) return [];
  const out = [];
  if (d.hot.length) out.push(`- Files changed most: ${d.hot.slice(0, 4).map(([f, c]) => `\`${f}\` (${c}×)`).join(', ')}`);
  for (const p of d.pairs.slice(-2)) out.push(`- Earlier trouble: ${clip(p.failed.outcome, 110)} → fixed: ${clip(p.fixed.outcome, 110)}`);
  if (d.troubleWords.length) out.push(`- Recurring trouble: ${d.troubleWords.slice(0, 5).join(', ')}`);
  return out;
}

/** Write or update the digest memory for a project. Returns { id, digest }. */
function writeDigest(store, project) {
  const p = store.get('projects/' + project);
  if (!p) throw new Error(`Unknown project "${project}"`);
  const d = digest(store, project);
  const body = markdown(d, p.title);
  const existing = store.list('note', { project }).find((n) => n.meta.experience_digest === project);
  if (existing && String(existing.body).replace(/Updated [^.]+\./, '') === body.replace(/Updated [^.]+\./, '')) return { id: existing.id, digest: d, changed: false };
  const rec = existing
    ? store.update(existing.id, { body })
    : store.create('note', { title: `Experience digest: ${p.title}`, type: 'reference', project, experience_digest: project, tags: ['experience', 'auto'], body });
  return { id: rec.id, digest: d, changed: true };
}

/** Refresh digests for every project that has a journal (cheap; run daily). */
function refreshAll(store) {
  const out = [];
  for (const p of store.list('project')) {
    try { if (fs.existsSync(journal.fileFor(store.vault, p.slug))) out.push(writeDigest(store, p.slug)); } catch { /* skip */ }
  }
  return out;
}

module.exports = { parse, digest, markdown, briefLines, writeDigest, refreshAll };
