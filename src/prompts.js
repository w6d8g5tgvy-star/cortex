'use strict';
// Prompt library with measured performance (2.2 #13). A prompt has versions; versions are compared on IDENTICAL tasks
// with OBJECTIVE scoring (hidden tests / exact checks), measuring accuracy, completion, tokens, time and cost. The winner
// becomes active; the loser is retired. A comparison that would cost money needs a budget and stops when it's reached.
const fs = require('fs');
const path = require('path');

const file = (vault) => path.join(vault, '.cortex', 'prompts.json');
const load = (vault) => { try { return JSON.parse(fs.readFileSync(file(vault), 'utf8')); } catch { return {}; } };
const save = (vault, all) => { fs.mkdirSync(path.dirname(file(vault)), { recursive: true }); fs.writeFileSync(file(vault), JSON.stringify(all, null, 1)); };
const clean = (n) => { const s = String(n || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); if (!s) throw new Error('Give the prompt a name'); return s; };

function addVersion(vault, name, text, { note = '', by = 'you' } = {}) {
  const all = load(vault); const k = clean(name);
  const p = all[k] || (all[k] = { name: k, versions: [], active: null });
  if (p.versions.some((v) => v.text === text)) throw new Error('That exact version already exists');
  const v = { v: p.versions.length + 1, text: String(text).slice(0, 20000), note: String(note).slice(0, 300), by, status: p.active ? 'candidate' : 'active', created: new Date().toISOString(), results: [] };
  p.versions.push(v); if (!p.active) p.active = v.v;
  save(vault, all); return { name: k, version: v.v, status: v.status };
}
function get(vault, name) { const p = load(vault)[clean(name)]; if (!p) throw new Error('No such prompt'); return p; }
function active(vault, name) { const p = get(vault, name); return p.versions.find((v) => v.v === p.active); }
function list(vault) { return Object.values(load(vault)).map((p) => ({ name: p.name, active: p.active, versions: p.versions.map((v) => ({ v: v.v, status: v.status, runs: v.results.length, passRate: rate(v), note: v.note })) })); }
const rate = (v) => { const t = v.results.reduce((n, r) => n + r.total, 0); return t ? +(v.results.reduce((n, r) => n + r.passed, 0) / t).toFixed(3) : null; };
const avg = (v, k) => (v.results.length ? v.results.reduce((n, r) => n + (r[k] || 0), 0) / v.results.length : null);

/**
 * Compare versions on the same tasks. runner(promptText, task) → { text, tokens, ms, cost }; each task has
 * { id, input, score(text) → { passed, total } }. Stops at maxCostUsd. Promotes the winner if it is clearly better
 * (higher pass rate; on a tie, ≥ 10% fewer tokens) over ≥ `minTrials` runs per version.
 */
async function compare(vault, name, { versions, tasks, runner, trials = 3, maxCostUsd = 0.5, minTrials = 3 }) {
  const all = load(vault); const p = all[clean(name)]; if (!p) throw new Error('No such prompt');
  const vs = (versions || p.versions.filter((v) => v.status !== 'retired').map((v) => v.v)).map((n) => p.versions.find((v) => v.v === n)).filter(Boolean);
  if (vs.length < 2) throw new Error('Need at least two versions to compare');
  let spent = 0; let stopped = false;
  outer: for (let i = 0; i < trials; i++) for (const t of tasks) for (const v of vs) {
    if (spent >= maxCostUsd) { stopped = true; break outer; }
    const r = await runner(`${v.text}\n\n${t.input}`, t);
    const sc = t.score(r.text || '');
    spent += r.cost || 0;
    v.results.push({ task: t.id, passed: sc.passed, total: sc.total, tokens: r.tokens || 0, ms: r.ms || 0, cost: r.cost || 0, completed: sc.passed === sc.total, at: new Date().toISOString() });
  }
  const summary = vs.map((v) => ({ v: v.v, status: v.status, runs: v.results.length, passRate: rate(v), avgTokens: avg(v, 'tokens') && Math.round(avg(v, 'tokens')), avgMs: avg(v, 'ms') && Math.round(avg(v, 'ms')), avgCost: avg(v, 'cost') && +avg(v, 'cost').toFixed(4), completion: v.results.length ? +(v.results.filter((r) => r.completed).length / v.results.length).toFixed(2) : null }));
  const cur = summary.find((s) => s.v === p.active);
  const best = [...summary].sort((a, b) => (b.passRate - a.passRate) || (a.avgTokens - b.avgTokens))[0];
  let promoted = null;
  if (best && cur && best.v !== cur.v && best.runs >= minTrials && cur.runs >= minTrials && (best.passRate > cur.passRate || (best.passRate === cur.passRate && best.avgTokens <= cur.avgTokens * 0.9))) {
    promoted = best.v;
    for (const v of p.versions) { if (v.v === best.v) v.status = 'active'; else if (v.v === cur.v) v.status = 'retired'; }
    p.active = best.v;
  }
  save(vault, all);
  return { summary, promoted, spent: +spent.toFixed(4), stoppedAtBudget: stopped };
}

module.exports = { addVersion, get, active, list, compare };
