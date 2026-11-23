'use strict';
// Multi-agent orchestration (2.2 #11) + recovery detection (#22) + search everywhere (#24).
// Tasks can depend on other tasks; agents ask for their next task and claim it (no two agents on the same task);
// tasks whose agent went quiet can be taken over; completed work can require verification by a DIFFERENT agent.
// One agent is the default: next_task hands out exactly one task.
const STALE_MS = 2 * 3600e3;
const ids = (v) => String(v || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
const family = (a) => require('./agents').family(String(a || ''));

function deps(store, t) { return ids(t.meta.depends_on).map((id) => store.get(id) || { id, missing: true, meta: {} }); }
function blockedBy(store, t) { return deps(store, t).filter((d) => d.missing || d.meta.status !== 'done'); }

/** When did this agent last do anything? (activity log) */
function lastSeen(store, agent) { for (let i = store.activity.length - 1; i >= 0; i--) if (store.activity[i].agent === agent) return Date.parse(store.activity[i].ts); return 0; }

/** The next task an agent should take: open, dependencies done, not owned by another active agent. Claims it. */
function nextTask(store, { agent, project, claim = true }) {
  const open = store.list('task', { project, open: true }).filter((t) => t.meta.status !== 'blocked');
  const now = Date.now();
  const cands = open.filter((t) => !blockedBy(store, t).length).filter((t) => {
    const owner = t.meta.assignee; if (!owner || owner === agent || owner === 'you') return !owner || owner === agent;
    return now - lastSeen(store, owner) > STALE_MS; // the owner went quiet: can be taken over
  });
  if (!cands.length) return { task: null, reason: open.length ? 'Every open task is owned by an active agent or waiting on other tasks.' : 'No open tasks.' };
  const PR = { urgent: 0, high: 1, medium: 2, low: 3 };
  cands.sort((a, b) => (a.meta.status === 'doing' ? -1 : 0) - (b.meta.status === 'doing' ? -1 : 0) || (PR[a.meta.priority] ?? 2) - (PR[b.meta.priority] ?? 2) || (a.created < b.created ? -1 : 1));
  const t = cands[0];
  const takeover = t.meta.assignee && t.meta.assignee !== agent;
  if (claim) {
    store.update(t.id, { assignee: agent, status: 'doing', ...(takeover ? { append: `**${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Cortex:** handed over from ${t.meta.assignee} (no activity for 2+ hours) to ${agent}.` } : {}) });
    store.log({ agent, action: takeover ? 'task.handoff' : 'task.claim', summary: `${takeover ? `Took over from ${t.meta.assignee}` : 'Claimed'}: "${t.title}"`, project: t.meta.project, ref: t.id });
  }
  return { task: { id: t.id, title: t.title, project: t.meta.project, priority: t.meta.priority, takeover: !!takeover, previousOwner: takeover ? t.meta.assignee : undefined } };
}

/** Claim a specific task; refuses if another active agent owns it (conflict prevention). */
function claim(store, id, agent) {
  const t = store.must(id);
  const owner = t.meta.assignee;
  if (owner && owner !== agent && owner !== 'you' && Date.now() - lastSeen(store, owner) < STALE_MS) throw new Error(`"${t.title}" is owned by ${owner}, who is active. Pick another task (next_task) or ask them with agent_send.`);
  const b = blockedBy(store, t);
  if (b.length) throw new Error(`"${t.title}" is waiting on: ${b.map((x) => x.title || x.id).join(', ')}`);
  store.update(t.id, { assignee: agent, status: t.meta.status === 'todo' ? 'doing' : t.meta.status });
  return { claimed: t.id };
}

/** After a task needing verification is done: create a verification task for a different agent. */
function requestVerification(store, t, doneBy) {
  if (!(t.meta.verify === true || t.meta.verify === 'true')) return null;
  const v = store.create('task', { title: `Verify: ${t.title}`, project: t.meta.project, priority: t.meta.priority || 'medium', depends_on: t.id, verifies: t.id, not_by: family(doneBy), body: `Independently check the work on [[${t.title}]] (${t.id}), done by ${doneBy}. Run its tests yourself and check every acceptance item. Report with task_verify (passed true/false + notes). You must not be the same kind of agent that did the work.` });
  store.update(t.id, { verified: 'pending', verify_task: v.id });
  return v;
}
function verify(store, verifyTaskOrTarget, agent, { passed, notes }) {
  let vt = store.must(verifyTaskOrTarget);
  if (!vt.meta.verifies) { const found = store.list('task').find((x) => x.meta.verifies === vt.id && x.meta.status !== 'done'); if (!found) throw new Error('No verification is pending for that task'); vt = found; }
  if (vt.meta.not_by && family(agent) === vt.meta.not_by) throw new Error(`Verification must be done by a different kind of agent than the one that did the work (${vt.meta.not_by}).`);
  const target = store.must(vt.meta.verifies);
  store.update(vt.id, { status: 'done', append: `**Verified by ${agent}: ${passed ? 'PASSED' : 'FAILED'}.** ${String(notes || '').slice(0, 1000)}` });
  if (passed) store.update(target.id, { verified: `passed by ${agent}`, append: `**Independently verified by ${agent}.** ${String(notes || '').slice(0, 400)}` });
  else store.update(target.id, { verified: `failed (${agent})`, status: 'doing', append: `**Verification FAILED (${agent}):** ${String(notes || '').slice(0, 800)}\nReopened.` });
  try { require('./notify').add(store.vault, { kind: passed ? 'done' : 'failed', title: `Verification ${passed ? 'passed' : 'failed'}: ${target.title}`, body: String(notes || '').slice(0, 200), ref: target.id, project: target.meta.project }); } catch { /* optional */ }
  return { task: target.id, passed: !!passed };
}

// ---------- recovery detection (#22) ----------
function recoverable(store, vault) {
  const out = []; const day = Date.now() - 24 * 3600e3;
  for (const s of require('./sessions').list(vault)) {
    if (!s.project || Date.parse(s.updated) < day) continue;
    const limit = /limit|rate|quota|max_output|context|compact/i.test(String(s.step || ''));
    if (s.status === 'error' || limit) out.push({ project: s.project, why: limit ? `stopped by a limit: ${String(s.step).slice(0, 80)}` : `ended with an error: ${String(s.step || '').slice(0, 80)}`, at: s.updated, agent: s.agent, task: s.task });
  }
  try {
    const ss = new (require('./smartsave').SmartSave)({ home: require('path').join(vault, '.cortex', 'smartsave'), store, config: () => require('./settings').load(vault).smartsave });
    for (const slug of ss.enabledProjects()) { const last = ss.snapshots(slug, { limit: 1 })[0]; if (last && Date.parse(last.time) > day && /agent stopped|compaction|session ended/.test(last.reason || '') && !out.some((o) => o.project === slug)) out.push({ project: slug, why: `last save: ${last.reason}`, at: last.time, snapshot: last.id }); }
  } catch { /* smartsave off */ }
  const latest = {}; for (const o of out) if (!latest[o.project] || latest[o.project].at < o.at) latest[o.project] = o;
  return Object.values(latest).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5);
}

// ---------- search everywhere (#24) ----------
function searchAll(store, vault, q, { limit = 8 } = {}) {
  const ql = String(q || '').trim(); if (!ql) return {};
  const ll = ql.toLowerCase();
  const hits = store.search(ql, { limit: 30 });
  const pick = (kind, f = () => true) => hits.filter((h) => h.rec.kind === kind && f(h.rec)).slice(0, limit).map((h) => ({ id: h.rec.id, title: h.rec.title, snippet: h.passage || h.snippet, project: h.rec.meta.project }));
  const out = {
    projects: pick('project'), tasks: pick('task'), decisions: pick('note', (r) => r.meta.type === 'decision'), memories: pick('note', (r) => r.meta.type !== 'decision' && !r.meta.agent_journal),
    research: [...pick('mind'), ...store.list('note').filter((n) => n.meta.fetcher_lesson && `${n.title} ${n.body}`.toLowerCase().includes(ll)).slice(0, 4).map((n) => ({ id: n.id, title: n.title }))].slice(0, limit),
    skills: store.list('skill').filter((s) => `${s.title} ${s.meta.description} ${s.body}`.toLowerCase().includes(ll)).slice(0, limit).map((s) => ({ id: s.id, title: s.title, snippet: s.meta.description })),
    activity: require('./userprefs').timeline(store, { q: ql, limit }).items.map((e) => ({ id: e.ref || e.ts, title: e.summary, at: e.ts, agent: e.agent })),
    conversations: require('./sessions').list(vault).filter((s) => `${s.title} ${s.turnPrompt || ''} ${s.step || ''}`.toLowerCase().includes(ll)).slice(0, limit).map((s) => ({ id: s.id, title: s.title, at: s.updated, agent: s.agent })),
    files: [],
  };
  try { // file names from each SmartSave-protected project's latest checkpoint (no disk scan per search)
    const ss = new (require('./smartsave').SmartSave)({ home: require('path').join(vault, '.cortex', 'smartsave'), store, config: () => require('./settings').load(vault).smartsave });
    const st = ss.state();
    for (const [slug, ps] of Object.entries(st.projects)) for (const p of Object.keys(ps.index || {})) if (p.toLowerCase().includes(ll) && out.files.length < limit) out.files.push({ id: `${slug}:${p}`, title: p, project: slug });
  } catch { /* none */ }
  return out;
}

module.exports = { nextTask, claim, blockedBy, requestVerification, verify, recoverable, searchAll };
