'use strict';
// Cortex Intelligence Engine (2.2): makes connected agents better without touching model weights.
//   failures  - structured mistakes + fixes (mined free from journals/tasks, or reported by agents), retrieved for
//               similar tasks
//   engine    - improvements: proposed → tested against a baseline → applied (or rejected) → rolled back if needed
//   router    - picks a tool/model per task from complexity, recorded success, verified usage and preferences
//   profiles  - per agent/model performance: measured numbers with sample sizes; "unavailable" is never guessed
//   qa        - deterministic checks when work is marked done (claims are not proof)
// All deterministic: zero AI tokens. Research basis: note "Cortex 2.2: research basis for the intelligence foundation".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STOP = new Set('a an and are as at be by can do for from how i in into is it its of on or so that the this to use with you your we our was were will not no but if then than also just'.split(' '));
const terms = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || [])].filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ''));
const jacc = (a, b) => { const A = new Set(a); const B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return A.size + B.size ? i / (A.size + B.size - i) : 0; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const dir = (vault) => { const d = path.join(vault, '.cortex', 'intel'); fs.mkdirSync(d, { recursive: true }); return d; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
const scrub = (s, vault) => { try { return require('../redact').redact(String(s || ''), vault); } catch { return String(s || ''); } };

// ======================= failures (#9) =======================
const TYPES = [
  ['rate-limit', /rate.?limit|usage limit|hit your .{0,20}limit|429|quota/i],
  ['context', /context (window|length)|too long|max_output_tokens|compaction/i],
  ['auth', /unauthori[sz]ed|401|403|forbidden|not signed in|expired token|permission denied for/i],
  ['permission', /permission denied|EACCES|EPERM|access is denied|smartscreen|blocked by/i],
  ['dependency', /cannot find module|module not found|no module named|command not found|not recognized as|missing dependency|ENOENT.*(node|npm|python)/i],
  ['test-failure', /tests? (fail|failed|failing)|assertion|expected .* (to|but)|\d+ failing/i],
  ['build', /build (fail|error)|compil(e|ation) (error|failed)|syntax ?error|type ?error/i],
  ['network', /ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket hang up|fetch failed|timed? ?out/i],
  ['merge-conflict', /merge conflict|CONFLICT \(content\)|rebase/i],
  ['wrong-target', /wrong (file|folder|project|branch)|not found: "|no such file/i],
];
const classify = (text) => (TYPES.find(([, re]) => re.test(text)) || ['other'])[0];

const failures = {
  file: (vault) => path.join(dir(vault), 'failures.json'),
  all(vault) { return readJson(this.file(vault), []); },
  /** Add (or merge into a similar existing) failure. Sensitive text is redacted; long text is clipped. */
  record(vault, f) {
    const all = this.all(vault);
    const rec = {
      task: clip(scrub(f.task, vault), 240), type: f.type || classify(`${f.task} ${f.cause} ${f.error || ''}`), cause: clip(scrub(f.cause || f.error, vault), 300) || null,
      fix: clip(scrub(f.fix, vault), 400) || null, prevention: clip(scrub(f.prevention, vault), 300) || null, project: f.project || null,
      model: f.model ? clip(f.model, 60) : null, tools: (f.tools || []).slice(0, 8).map((t) => clip(t, 40)), evidence: clip(scrub(f.evidence, vault), 300) || null, source: f.source || 'agent',
    };
    const key = terms(`${rec.task} ${rec.cause}`);
    const same = all.find((x) => x.type === rec.type && x.project === rec.project && jacc(terms(`${x.task} ${x.cause}`), key) >= 0.5);
    if (same) {
      same.count = (same.count || 1) + 1; same.last = new Date().toISOString();
      for (const k of ['fix', 'prevention', 'evidence']) if (rec[k] && !same[k]) same[k] = rec[k];
      if (rec.model && !(same.models || []).includes(rec.model)) same.models = [...(same.models || []), rec.model].slice(-6);
      writeJson(this.file(vault), all); return { ...same, merged: true };
    }
    const out = { id: 'fail-' + crypto.randomBytes(4).toString('hex'), ...rec, models: rec.model ? [rec.model] : [], count: 1, first: new Date().toISOString(), last: new Date().toISOString() };
    delete out.model;
    all.push(out); writeJson(this.file(vault), all.slice(-2000)); return out;
  },
  /** Free mining: experience digest fail→fix pairs, unresolved trouble, and blocked tasks. Idempotent. */
  mine(store) {
    const exp = require('../experience');
    const seen = readJson(path.join(dir(store.vault), 'mined.json'), {});
    let added = 0;
    for (const p of store.list('project')) {
      let d; try { d = exp.digest(store, p.slug); } catch { continue; }
      for (const pr of d.pairs || []) {
        const k = `${p.slug}|${pr.failed.when}|${pr.failed.title}`; if (seen[k]) continue; seen[k] = 1;
        this.record(store.vault, { task: pr.failed.title, cause: pr.failed.outcome, fix: pr.fixed.outcome, evidence: `journal: failed ${pr.failed.when}, fixed ${pr.fixed.when}`, project: p.slug, model: pr.failed.agent, source: 'journal' }); added++;
      }
    }
    for (const t of store.list('task', { open: true })) {
      if (t.meta.status !== 'blocked') continue;
      const k = `blocked|${t.id}`; if (seen[k]) continue; seen[k] = 1;
      const last = String(t.body || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      this.record(store.vault, { task: t.title, cause: last, project: t.meta.project, evidence: `task ${t.id} is blocked`, source: 'task' }); added++;
    }
    writeJson(path.join(dir(store.vault), 'mined.json'), seen);
    return { added };
  },
  /** Failures relevant to a task (term overlap, preferring ones with a known fix and recurring ones). */
  lookup(vault, text, { project, max = 3 } = {}) {
    const want = terms(text); if (!want.length) return [];
    return this.all(vault).map((f) => {
      const s = jacc(want, terms(`${f.task} ${f.cause} ${f.type}`));
      return { f, s: s + (f.fix ? 0.05 : 0) + Math.min(0.1, (f.count - 1) * 0.02) + (project && f.project === project ? 0.05 : 0) };
    }).filter((x) => x.s >= 0.12).sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.f);
  },
  briefLines(vault, text, opts) {
    return this.lookup(vault, text, opts).map((f) => `- ${f.type}${f.count > 1 ? ` (seen ${f.count}×)` : ''}: ${clip(f.task, 90)}${f.cause ? ` → cause: ${clip(f.cause, 120)}` : ''}${f.fix ? ` → fix that worked: ${clip(f.fix, 160)}` : ''}${f.prevention ? ` → prevent: ${clip(f.prevention, 120)}` : ''}`);
  },
  stats(vault) { const all = this.all(vault); const by = {}; for (const f of all) by[f.type] = (by[f.type] || 0) + f.count; return { total: all.length, occurrences: all.reduce((n, f) => n + f.count, 0), withFix: all.filter((f) => f.fix).length, byType: by }; },
};

// ======================= improvements (#4) =======================
const MARK = (id) => [`<!-- cortex-improvement:${id} -->`, `<!-- /cortex-improvement:${id} -->`];
const engine = {
  file: (vault) => path.join(dir(vault), 'improvements.json'),
  all(vault) { return readJson(this.file(vault), []); },
  save(vault, all) { writeJson(this.file(vault), all); },
  get(vault, id) { return this.all(vault).find((x) => x.id === id); },
  /** A proposed improvement with the baseline it must beat. kind: instruction | lesson | skill | prompt | routing | setting */
  propose(vault, { title, kind = 'instruction', project = null, change, baseline = null, from = 'cortex', higherIsBetter = true }) {
    if (!title || !change) throw new Error('An improvement needs a title and the change');
    const all = this.all(vault);
    const dup = all.find((x) => x.title === title && x.project === project && ['proposed', 'testing', 'verified', 'applied'].includes(x.status));
    if (dup) return dup;
    const x = { id: 'imp-' + crypto.randomBytes(4).toString('hex'), title: clip(title, 160), kind, project, change: clip(change, 2000), baseline, higherIsBetter, status: 'proposed', from, created: new Date().toISOString(), history: [{ at: new Date().toISOString(), event: 'proposed', by: from }] };
    all.push(x); this.save(vault, all); return x;
  },
  /** Record a test result. It is verified only if it beats the baseline with n ≥ 3; otherwise rejected. */
  test(vault, id, { value, n, metric, notes }) {
    const all = this.all(vault); const x = all.find((y) => y.id === id); if (!x) throw new Error('Improvement not found');
    const base = x.baseline && Number.isFinite(x.baseline.value) ? x.baseline.value : null;
    const better = base === null ? null : (x.higherIsBetter ? value > base : value < base);
    x.result = { value, n, metric: metric || (x.baseline && x.baseline.metric), notes: clip(notes, 300), at: new Date().toISOString() };
    x.status = n >= 3 && better ? 'verified' : n < 3 ? 'testing' : 'rejected';
    x.history.push({ at: x.result.at, event: `tested: ${value} vs baseline ${base} (n=${n}) → ${x.status}` });
    this.save(vault, all); return x;
  },
  /** Apply a verified improvement. Instruction-type changes go into a marked block in the project's instructions. */
  apply(store, id, { by = 'you', force = false } = {}) {
    const all = this.all(store.vault); const x = all.find((y) => y.id === id); if (!x) throw new Error('Improvement not found');
    if (x.status !== 'verified' && !force) throw new Error(`Only verified improvements can be applied (this one is ${x.status}). Test it first, or apply it yourself as an experiment.`);
    if (x.kind === 'instruction' && x.project) {
      const p = store.must('projects/' + x.project); const [a, b] = MARK(x.id);
      const cur = String(p.meta.instructions || '');
      if (!cur.includes(a)) store.update(p.id, { instructions: `${cur}${cur ? '\n' : ''}${a}\n${x.change}\n${b}` });
    }
    x.status = 'applied'; x.appliedAt = new Date().toISOString(); x.experiment = !!force && x.status !== 'verified';
    x.history.push({ at: x.appliedAt, event: force ? 'applied as an experiment (not yet verified)' : 'applied', by });
    this.save(store.vault, all); return x;
  },
  rollback(store, id, { by = 'you', reason = '' } = {}) {
    const all = this.all(store.vault); const x = all.find((y) => y.id === id); if (!x) throw new Error('Improvement not found');
    if (x.kind === 'instruction' && x.project) {
      const p = store.get('projects/' + x.project);
      if (p) { const [a, b] = MARK(x.id); const cur = String(p.meta.instructions || ''); const i = cur.indexOf(a); const j = cur.indexOf(b); if (i >= 0 && j > i) store.update(p.id, { instructions: (cur.slice(0, i) + cur.slice(j + b.length)).replace(/\n{3,}/g, '\n\n').trim() }); }
    }
    x.status = 'rolled-back'; x.history.push({ at: new Date().toISOString(), event: `rolled back${reason ? ': ' + clip(reason, 200) : ''}`, by });
    this.save(store.vault, all); return x;
  },
  reject(vault, id, by = 'you') { const all = this.all(vault); const x = all.find((y) => y.id === id); if (!x) throw new Error('Improvement not found'); x.status = 'rejected'; x.history.push({ at: new Date().toISOString(), event: 'rejected', by }); this.save(vault, all); return x; },
  /**
   * Turn recurring failures into proposals: a failure type seen ≥ 3 times in a project, with a known fix, becomes a
   * prevention rule for that project's instructions. Baseline = that project's current failure rate (from journals).
   */
  proposeFromFailures(store) {
    const out = [];
    for (const f of failures.all(store.vault)) {
      if (!f.project || f.count < 3 || !(f.fix || f.prevention)) continue;
      const rate = this.failureRate(store, f.project, f.type);
      out.push(this.propose(store.vault, { title: `Prevent recurring ${f.type} in ${f.project}`, kind: 'instruction', project: f.project, change: `Known pitfall (seen ${f.count}×): ${clip(f.task, 120)}. ${f.prevention ? 'Prevent it: ' + f.prevention : 'What fixed it before: ' + f.fix}`, baseline: { metric: `${f.type} failure rate`, value: rate.rate, n: rate.sessions }, higherIsBetter: false, from: 'failure database' }));
    }
    return out;
  },
  /** Share of a project's recorded sessions (optionally since a time) whose outcome matches a failure type. */
  failureRate(store, project, type, since = null) {
    let parsed; try { const j = store.list('note', { project }).find((r) => r.meta.agent_journal); parsed = j ? require('../experience').parse(j.body) : { sessions: [] }; } catch { parsed = { sessions: [] }; }
    const s = parsed.sessions.filter((x) => !since || `${x.date} ${x.time}` >= since);
    const bad = s.filter((x) => x.status !== 'ok' && classify(`${x.title} ${x.outcome}`) === type);
    return { rate: s.length ? +(bad.length / s.length).toFixed(3) : 0, sessions: s.length, failures: bad.length };
  },
  /** After ≥ 5 new sessions, measure applied instruction improvements; roll back ones that made things worse. */
  evaluate(store) {
    const res = [];
    for (const x of this.all(store.vault).filter((y) => y.status === 'applied' && y.kind === 'instruction' && y.baseline)) {
      const type = (x.baseline.metric || '').replace(/ failure rate$/, '');
      const since = x.appliedAt.slice(0, 10) + ' ' + x.appliedAt.slice(11, 16);
      const now = this.failureRate(store, x.project, type, since);
      if (now.sessions < 5) { res.push({ id: x.id, waiting: 5 - now.sessions }); continue; }
      const all = this.all(store.vault); const y = all.find((z) => z.id === x.id);
      y.measured = { value: now.rate, n: now.sessions, at: new Date().toISOString() };
      y.history.push({ at: y.measured.at, event: `measured after applying: ${now.rate} vs baseline ${x.baseline.value} over ${now.sessions} sessions` });
      this.save(store.vault, all);
      if (now.rate > x.baseline.value) { this.rollback(store, x.id, { by: 'cortex', reason: 'it made the failure rate worse' }); res.push({ id: x.id, rolledBack: true }); } else res.push({ id: x.id, kept: true, rate: now.rate });
    }
    return res;
  },
};

// ======================= routing (#5) =======================
const HIGH = /\b(architect\w*|design|refactor\w*|migrat\w*|security|vulnerab\w*|concurren\w*|race condition|performance|optimi[sz]\w*|debug\w*|root cause|algorithm|distributed|multi-?step|end.?to.?end|investigat\w*|research)\b/i;
const LOW = /\b(typo|rename|format\w*|lint|comment|readme|docs?|spelling|bump|version|small|simple|quick|trivial|one.?line)\b/i;
const TIERS = { low: 'haiku', medium: 'sonnet', high: 'opus' };
const router = {
  complexity({ prompt = '', taskBody = '', priority, failuresSeen = 0 }) {
    const t = `${prompt}\n${taskBody}`;
    let s = 0; const why = [];
    const len = t.length; if (len > 1500) { s += 2; why.push('long, detailed request'); } else if (len > 400) { s += 1; why.push('medium-length request'); }
    if (HIGH.test(t)) { s += 2; why.push(`hard kind of work (${t.match(HIGH)[0]})`); }
    if (LOW.test(t) && !HIGH.test(t)) { s -= 2; why.push(`small kind of change (${t.match(LOW)[0]})`); }
    const files = (t.match(/[\w/-]+\.(js|ts|tsx|py|java|go|rs|cs|cpp|lua|luau|md|json)\b/g) || []).length; if (files >= 4) { s += 1; why.push(`${files} files mentioned`); }
    if (priority === 'urgent' || priority === 'high') { s += 1; why.push(`${priority} priority`); }
    if (failuresSeen >= 2) { s += 1; why.push(`${failuresSeen} similar failures before`); }
    return { score: s, band: s >= 3 ? 'high' : s <= 0 ? 'low' : 'medium', why };
  },
  /** Success rate per tool/model from recorded runs (sessions that finished or failed). */
  history(vault) {
    const by = {};
    for (const s of require('../sessions').list(vault)) {
      if (!['done', 'error'].includes(s.status) || !s.model) continue;
      const k = `${s.tool || (s.agent === 'codex' ? 'codex' : 'claude')}:${modelFamily(s.model)}`;
      const r = by[k] || (by[k] = { runs: 0, ok: 0, cost: 0, costN: 0 });
      r.runs++; if (s.status === 'done' && !/limit|fail|error/i.test(String(s.step || ''))) r.ok++;
      if (Number.isFinite(s.cost_usd)) { r.cost += s.cost_usd; r.costN++; }
    }
    return by;
  },
  /** Choose a tool+model. Manual choices always win; returns the reasons so the user can see why. */
  route(store, { prompt = '', project, task, tool, model, settings } = {}) {
    const vault = store.vault;
    const conf = (settings || require('../settings').load(vault)).routing || {};
    if (model && !/^auto$/i.test(model)) return { tool: tool || 'claude', model, manual: true, reasons: ['you chose this model'] };
    if (conf.mode === 'manual' && conf.model) return { tool: conf.tool || tool || 'claude', model: conf.model, manual: true, reasons: ['your default model (Settings → routing is manual)'] };
    const t = task ? store.get(task) : null;
    const pm = project ? (store.get('projects/' + project) || { meta: {} }).meta : {};
    if (pm.agent_model && !tool) return { tool: pm.agent_tool || 'claude', model: pm.agent_model, manual: true, reasons: [`this project's chosen model`] };
    const fs_ = failures.lookup(vault, `${prompt} ${t ? t.title : ''}`, { project, max: 5 });
    const c = this.complexity({ prompt, taskBody: t ? `${t.title}\n${t.body}` : '', priority: t && t.meta.priority, failuresSeen: fs_.reduce((n, f) => n + f.count, 0) });
    const reasons = [...c.why];
    let useTool = tool || conf.tool || 'claude';
    // verified usage pressure (Codex writes its quota); never invent Claude numbers
    try {
      const lim = require('../usage').scan().codex.limits;
      const pct = lim && Date.now() - Date.parse(lim.checkedAt) < 30 * 60000 ? Math.max(lim.primary ? lim.primary.usedPercent : 0, lim.secondary ? lim.secondary.usedPercent : 0) : null;
      if (useTool === 'codex' && pct !== null && pct >= 90 && !tool) { useTool = 'claude'; reasons.push(`Codex usage is at ${Math.round(pct)}%`); }
    } catch { /* usage unknown: ignore */ }
    if (useTool === 'codex') return { tool: 'codex', model: undefined, band: c.band, reasons: [...reasons, 'Codex picks its own default model'] };
    let pick = TIERS[c.band];
    const h = this.history(vault);
    const cheaper = { opus: 'sonnet', sonnet: 'haiku' };
    const ch = cheaper[pick] && h[`claude:${cheaper[pick]}`];
    if (ch && ch.runs >= 5 && ch.ok / ch.runs >= 0.85) { reasons.push(`${cheaper[pick]} succeeded ${ch.ok}/${ch.runs} times here, so the cheaper model is enough`); pick = cheaper[pick]; }
    const cur = h[`claude:${pick}`];
    if (cur && cur.runs >= 5 && cur.ok / cur.runs < 0.5) { const up = { haiku: 'sonnet', sonnet: 'opus' }[pick]; if (up) { reasons.push(`${pick} only succeeded ${cur.ok}/${cur.runs} times here, so a stronger model`); pick = up; } }
    if ((conf.never || []).includes(pick)) { reasons.push(`you turned off ${pick}`); pick = pick === 'opus' ? 'sonnet' : 'opus'; }
    return { tool: 'claude', model: pick, band: c.band, score: c.score, reasons };
  },
  log(vault, entry) { try { fs.appendFileSync(path.join(dir(vault), 'routing.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ } },
  recent(vault, n = 20) { try { return fs.readFileSync(path.join(dir(vault), 'routing.jsonl'), 'utf8').trim().split('\n').slice(-n).reverse().map((l) => JSON.parse(l)); } catch { return []; } },
};
function modelFamily(m) { const s = String(m || '').toLowerCase(); return /opus/.test(s) ? 'opus' : /sonnet/.test(s) ? 'sonnet' : /haiku/.test(s) ? 'haiku' : /gpt|o\d|codex/.test(s) ? s.replace(/[^\w.-]/g, '').slice(0, 30) : s.slice(0, 30) || 'unknown'; }

// ======================= performance profiles (#6) =======================
function profiles(store) {
  const by = {};
  const add = (k, label) => by[k] || (by[k] = { key: k, label, runs: 0, ok: 0, errors: 0, cost: [], turns: [], ms: [], tokensOut: [], tokensIn: [], qaPass: 0, qaFail: 0, failures: 0, lastSeen: null });
  for (const s of require('../sessions').list(store.vault)) {
    if (!['done', 'error'].includes(s.status)) continue;
    const k = `${s.agent || 'agent'} · ${s.model ? modelFamily(s.model) : 'model unknown'}`;
    const p = add(k, k); p.runs++;
    if (s.status === 'done' && !/limit|fail/i.test(String(s.step || ''))) p.ok++; else p.errors++;
    if (Number.isFinite(s.cost_usd)) p.cost.push(s.cost_usd);
    if (Number.isFinite(s.turns)) p.turns.push(s.turns);
    if (s.usage && Number.isFinite(s.usage.output)) { p.tokensOut.push(s.usage.output); p.tokensIn.push(s.usage.input || 0); }
    const a = Date.parse(s.created || s.started); const b = Date.parse(s.updated); if (a && b && b > a) p.ms.push(b - a);
    if (!p.lastSeen || s.updated > p.lastSeen) p.lastSeen = s.updated;
  }
  for (const t of store.list('task')) {
    if (!t.meta.qa || !t.meta.model) continue;
    const k = Object.keys(by).find((x) => x.endsWith(modelFamily(t.meta.model))); if (!k) continue;
    if (String(t.meta.qa).startsWith('pass')) by[k].qaPass++; else by[k].qaFail++;
  }
  for (const f of failures.all(store.vault)) for (const m of f.models || []) { const k = Object.keys(by).find((x) => x.startsWith(m) || x.endsWith(modelFamily(m))); if (k) by[k].failures += f.count; }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const metric = (value, n, unit, note) => (n ? { value: value === null ? null : +value.toFixed(unit === '$' ? 4 : 2), n, unit, source: 'measured' } : { value: null, n: 0, unit, source: 'unavailable', note });
  return Object.values(by).sort((a, b) => b.runs - a.runs).map((p) => ({
    agent: p.label, lastSeen: p.lastSeen,
    successRate: metric(p.runs ? p.ok / p.runs : null, p.runs, 'ratio'),
    errorRate: metric(p.runs ? p.errors / p.runs : null, p.runs, 'ratio'),
    avgCost: metric(avg(p.cost), p.cost.length, '$', 'the tool did not report cost'),
    avgTurns: metric(avg(p.turns), p.turns.length, 'turns', 'not reported'),
    avgMinutes: metric(avg(p.ms) && avg(p.ms) / 60000, p.ms.length, 'min', 'no timing'),
    avgOutputTokens: metric(avg(p.tokensOut), p.tokensOut.length, 'tokens', 'token counts not reported'),
    qaPassRate: metric(p.qaPass + p.qaFail ? p.qaPass / (p.qaPass + p.qaFail) : null, p.qaPass + p.qaFail, 'ratio', 'no checked tasks yet'),
    recordedFailures: p.failures,
    codingAccuracy: { value: null, n: 0, source: 'unavailable', note: 'measured by the train ai benchmarks; see that project' },
  }));
}

// ======================= quality assurance (#16) =======================
function qaCheck(store, taskRec, { outcome = '', session = null } = {}) {
  const body = String(taskRec.body || '');
  const checks = [];
  const open = (body.match(/^\s*[-*] \[ \] .+$/gm) || []).map((l) => l.replace(/^\s*[-*] \[ \] /, '').trim());
  checks.push({ name: 'Acceptance checklist complete', ok: open.length === 0, detail: open.length ? `${open.length} unchecked: ${open.slice(0, 3).map((x) => clip(x, 60)).join('; ')}` : 'no unchecked items' });
  const text = `${outcome}\n${body.split('\n').slice(-12).join('\n')}`;
  const failWords = /\b(fail(ed|ing|s)?|error|could ?n[o']t|unable to|did not work|didn'?t work|not (done|finished|implemented)|blocked|TODO|skipped)\b/i;
  checks.push({ name: 'No reported failures in the outcome', ok: !failWords.test(outcome), detail: failWords.test(outcome) ? `outcome says: "${clip((outcome.match(new RegExp(`.{0,60}${failWords.source}.{0,60}`, 'i')) || [''])[0], 140)}"` : 'clean' });
  const needsTests = /\b(test|tests|tested|bug|fix|regression|feature|implement)\b/i.test(`${taskRec.title} ${body}`);
  const evidence = /\b(tests? (pass|passed|passing|green)|all \d+ .*pass|\d+ passing|ran (the )?tests|npm test|pytest|✓)\b/i.test(text) || (session && session.commands > 0 && /pass/i.test(String(session.result || '')));
  if (needsTests) checks.push({ name: 'Evidence that tests ran and passed', ok: !!evidence, detail: evidence ? 'found test evidence' : 'no test results mentioned: say which tests ran and their result' });
  const deliver = (body.match(/^\s*(deliverables?|must include|acceptance criteria)\s*:\s*(.+)$/gim) || []).map((l) => l.split(':').slice(1).join(':')).join(',').split(/[,;]/).map((x) => x.trim()).filter((x) => x.length > 2);
  if (deliver.length) { const miss = deliver.filter((dlv) => !terms(dlv).every((w) => text.toLowerCase().includes(w))); checks.push({ name: 'Named deliverables mentioned', ok: miss.length === 0, detail: miss.length ? `not mentioned: ${miss.slice(0, 4).join(', ')}` : 'all mentioned' }); }
  const failed = checks.filter((c) => !c.ok);
  return { verdict: failed.length === 0 ? 'pass' : failed.some((c) => /checklist|failures/.test(c.name)) ? 'fail' : 'warn', checks, at: new Date().toISOString() };
}

module.exports = { failures, engine, router, profiles, qaCheck, classify, modelFamily, TIERS };
