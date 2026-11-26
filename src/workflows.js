'use strict';
// Visual workflow builder (2.3, checklist #34): connect a trigger to AI agents, tools, conditions, approvals, tasks,
// notifications and outputs without code. Workflows are JSON in <vault>/.cortex/workflows/<id>.json; every run keeps
// a step-by-step log (for debugging) in .cortex/workflows/runs/<runId>.json.
//
// Safety: a run stops at its limits (steps, agent runs, minutes), so a loop or a runaway agent can't go on forever.
// "Test" runs simulate agents and anything that would write, so a workflow can be checked for free before it's used.
// Tools are a fixed allow-list of Cortex actions; nothing runs shell commands.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = (vault) => path.join(vault, '.cortex', 'workflows');
const runDir = (vault) => path.join(dir(vault), 'runs');
const now = () => new Date().toISOString();
const rid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); }
const safeId = (id) => String(id || '').replace(/[^\w-]/g, '').slice(0, 60);

// ---------------- building blocks ----------------
const NODE_TYPES = {
  trigger: { label: 'Trigger', help: 'What starts the workflow: by hand, on a schedule, or when a task is created or finished.' },
  agent: { label: 'AI agent', help: 'Ask Claude Code or Codex to do something. Gets the Cortex brief like any agent run.' },
  tool: { label: 'Tool', help: 'A Cortex action: search memories, save a memory, update a task, or read a project brief.' },
  condition: { label: 'Condition', help: 'Go one way if something is true, another way if not.' },
  approval: { label: 'Approval', help: 'Pause until you approve or reject (from the dashboard or your phone).' },
  task: { label: 'Create task', help: 'Add a task to a project board.' },
  notify: { label: 'Notification', help: 'Send yourself a notification.' },
  output: { label: 'Output', help: 'Finish, optionally saving the result as a memory.' },
};
const TRIGGERS = ['manual', 'schedule', 'task.created', 'task.done'];
const TOOLS = ['memory_search', 'memory_write', 'task_update', 'project_brief'];
const OPS = ['contains', 'not_contains', 'equals', 'matches', 'gt', 'lt', 'empty', 'not_empty'];
const DEFAULT_LIMITS = { maxSteps: 50, maxAgentRuns: 3, maxMinutes: 60 };

/** {{last.output}}, {{trigger.title}}, {{steps.<node>.output}}, {{workflow.name}} */
function fill(text, ctx) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => {
    let v = ctx; for (const part of k.split('.')) { v = v == null ? undefined : v[part]; }
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function check(cond, ctx) {
  const left = fill(cond.left || '{{last.output}}', ctx); const right = fill(cond.value == null ? '' : cond.value, ctx);
  switch (cond.op || 'contains') {
    case 'contains': return left.toLowerCase().includes(right.toLowerCase());
    case 'not_contains': return !left.toLowerCase().includes(right.toLowerCase());
    case 'equals': return left.trim() === right.trim();
    case 'matches': try { return new RegExp(right, 'i').test(left); } catch { return false; }
    case 'gt': return Number(left) > Number(right);
    case 'lt': return Number(left) < Number(right);
    case 'empty': return !left.trim();
    case 'not_empty': return !!left.trim();
    default: return false;
  }
}

/** Problems that would stop a workflow from running (errors) or are probably mistakes (warnings). */
function validate(wf) {
  const errors = []; const warnings = [];
  const nodes = Array.isArray(wf && wf.nodes) ? wf.nodes : [];
  if (!String(wf && wf.name || '').trim()) errors.push('Give the workflow a name.');
  if (!nodes.length) errors.push('Add at least a trigger and one step.');
  const ids = new Set();
  for (const n of nodes) {
    if (!n.id) errors.push('A step has no id.'); else if (ids.has(n.id)) errors.push(`Two steps are called "${n.id}".`); ids.add(n.id);
    if (!NODE_TYPES[n.type]) errors.push(`"${n.id}" has an unknown type "${n.type}".`);
  }
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) errors.push('A workflow needs exactly one trigger.');
  const c = (n) => n.config || {};
  for (const n of nodes) {
    for (const t of [...(n.next || []), ...(n.else || [])]) if (!ids.has(t)) errors.push(`"${n.id}" points to a missing step "${t}".`);
    if (n.type === 'trigger') {
      if (!TRIGGERS.includes(c(n).on || 'manual')) errors.push(`Unknown trigger "${c(n).on}".`);
      if (c(n).on === 'schedule' && !(Number(c(n).everyMinutes) >= 5)) errors.push('A schedule must repeat every 5 minutes or more.');
    }
    if (n.type === 'agent' && !String(c(n).prompt || '').trim()) errors.push(`"${n.id}": tell the agent what to do.`);
    if (n.type === 'tool' && !TOOLS.includes(c(n).name)) errors.push(`"${n.id}": choose a tool (${TOOLS.join(', ')}).`);
    if (n.type === 'condition') { if (!OPS.includes(c(n).op || 'contains')) errors.push(`"${n.id}": unknown check "${c(n).op}".`); if (!(n.else || []).length && !(n.next || []).length) warnings.push(`"${n.id}" doesn't lead anywhere.`); }
    if (n.type === 'task' && !String(c(n).title || '').trim()) errors.push(`"${n.id}": give the task a title.`);
    if (n.type === 'notify' && !String(c(n).title || '').trim()) errors.push(`"${n.id}": give the notification a title.`);
  }
  if (triggers.length === 1) { // reachability + loops
    const seen = new Set(); const stack = [triggers[0].id]; const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    while (stack.length) { const id = stack.pop(); if (seen.has(id) || !byId[id]) continue; seen.add(id); stack.push(...(byId[id].next || []), ...(byId[id].else || [])); }
    for (const n of nodes) if (!seen.has(n.id)) warnings.push(`"${n.id}" can never be reached from the trigger.`);
    const onStack = new Set(); const done = new Set(); let loop = false;
    const dfs = (id) => { if (onStack.has(id)) { loop = true; return; } if (done.has(id) || !byId[id]) return; onStack.add(id); for (const t of [...(byId[id].next || []), ...(byId[id].else || [])]) dfs(t); onStack.delete(id); done.add(id); };
    dfs(triggers[0].id);
    if (loop) warnings.push(`This workflow loops. It will stop after ${Number(wf.limits && wf.limits.maxSteps) || DEFAULT_LIMITS.maxSteps} steps.`);
  }
  const L = { ...DEFAULT_LIMITS, ...(wf && wf.limits) };
  if (!(L.maxSteps >= 1 && L.maxSteps <= 500)) errors.push('Step limit must be between 1 and 500.');
  if (!(L.maxAgentRuns >= 0 && L.maxAgentRuns <= 20)) errors.push('Agent run limit must be between 0 and 20.');
  if (!(L.maxMinutes >= 1 && L.maxMinutes <= 24 * 60)) errors.push('Time limit must be between 1 minute and 24 hours.');
  return { ok: !errors.length, errors, warnings };
}

// ---------------- storage ----------------
function list(vault) {
  let files = []; try { files = fs.readdirSync(dir(vault)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJson(path.join(dir(vault), f))).filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function get(vault, id) { return readJson(path.join(dir(vault), safeId(id) + '.json')); }
function save(vault, wf) {
  const v = validate(wf); if (!v.ok) { const e = new Error(v.errors.join(' ')); e.validation = v; throw e; }
  const id = safeId(wf.id) || rid('wf');
  const prev = get(vault, id);
  const out = { id, name: String(wf.name).slice(0, 120), description: String(wf.description || '').slice(0, 1000), enabled: wf.enabled !== false, nodes: wf.nodes, limits: { ...DEFAULT_LIMITS, ...(wf.limits || {}) }, layout: wf.layout || (prev && prev.layout) || {}, created: (prev && prev.created) || now(), updated: now(), version: ((prev && prev.version) || 0) + 1, template: wf.template || (prev && prev.template) || undefined };
  writeJson(path.join(dir(vault), id + '.json'), out);
  return { workflow: out, warnings: v.warnings };
}
function remove(vault, id) { const f = path.join(dir(vault), safeId(id) + '.json'); if (!fs.existsSync(f)) return false; const trash = path.join(dir(vault), 'deleted'); fs.mkdirSync(trash, { recursive: true }); fs.renameSync(f, path.join(trash, `${safeId(id)}-${Date.now()}.json`)); return true; }
function runs(vault, { workflow, limit = 30 } = {}) {
  let files = []; try { files = fs.readdirSync(runDir(vault)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJson(path.join(runDir(vault), f))).filter((r) => r && (!workflow || r.workflow === workflow)).sort((a, b) => (a.started < b.started ? 1 : -1)).slice(0, limit);
}
const getRun = (vault, id) => readJson(path.join(runDir(vault), safeId(id) + '.json'));
const saveRun = (vault, run) => writeJson(path.join(runDir(vault), run.id + '.json'), run);

// ---------------- templates ----------------
const TEMPLATES = [
  { template: 'review-before-merge', name: 'Fix a task, with my approval', description: 'An agent works on the task, you approve the result, then it is marked done and you get a notification.',
    nodes: [
      { id: 'start', type: 'trigger', config: { on: 'manual' }, next: ['work'] },
      { id: 'work', type: 'agent', config: { prompt: 'Work on this: {{trigger.title}}\n{{trigger.body}}\nSummarize what you changed in the last line.', tool: 'claude', maxMinutes: 30 }, next: ['ok'] },
      { id: 'ok', type: 'approval', config: { message: 'Agent result: {{last.output}}' }, next: ['notify'], else: ['retry'] },
      { id: 'notify', type: 'notify', config: { title: 'Done: {{trigger.title}}', body: '{{steps.work.output}}' }, next: ['end'] },
      { id: 'retry', type: 'task', config: { title: 'Redo: {{trigger.title}}', body: 'Rejected result: {{steps.work.output}}', priority: 'high' }, next: [] },
      { id: 'end', type: 'output', config: { save: 'none' }, next: [] },
    ] },
  { template: 'research-to-note', name: 'Research, then save a memory', description: 'Checks what Cortex already knows, researches only if needed, and saves the answer as a memory.',
    nodes: [
      { id: 'start', type: 'trigger', config: { on: 'manual' }, next: ['known'] },
      { id: 'known', type: 'tool', config: { name: 'memory_search', query: '{{trigger.question}}' }, next: ['has'] },
      { id: 'has', type: 'condition', config: { left: '{{last.output}}', op: 'empty' }, next: ['research'], else: ['end'] },
      { id: 'research', type: 'agent', config: { prompt: 'Research and answer briefly, with sources: {{trigger.question}}', tool: 'claude', maxMinutes: 20 }, next: ['save'] },
      { id: 'save', type: 'output', config: { save: 'memory', title: 'Research: {{trigger.question}}' }, next: [] },
      { id: 'end', type: 'output', config: { save: 'none' }, next: [] },
    ] },
  { template: 'done-task-followup', name: 'When a task is finished, tell me', description: 'Every time a task is marked done, sends a notification. Add a condition to only follow up important ones.',
    nodes: [
      { id: 'start', type: 'trigger', config: { on: 'task.done' }, next: ['important'] },
      { id: 'important', type: 'condition', config: { left: '{{trigger.priority}}', op: 'matches', value: 'high|urgent' }, next: ['tell'], else: [] },
      { id: 'tell', type: 'notify', config: { title: 'Finished: {{trigger.title}}', body: 'Project: {{trigger.project}}' }, next: [] },
    ] },
  { template: 'daily-review', name: 'Daily project review', description: 'Once a day, an agent reads the project brief and lists the three most useful next tasks.',
    nodes: [
      { id: 'start', type: 'trigger', config: { on: 'schedule', everyMinutes: 1440, project: '' }, next: ['brief'] },
      { id: 'brief', type: 'tool', config: { name: 'project_brief', project: '{{trigger.project}}' }, next: ['plan'] },
      { id: 'plan', type: 'agent', config: { prompt: 'Read this brief and list the three most useful next tasks, one line each:\n{{last.output}}', tool: 'claude', maxMinutes: 10 }, next: ['out'] },
      { id: 'out', type: 'output', config: { save: 'memory', title: 'Daily review {{today}}' }, next: [] },
    ] },
];

// ---------------- running ----------------
/**
 * Run a workflow. `deps`: { store, launchAgent(opts) → Promise<{ status, result, runId }>, notify(vault, n) }.
 * test=true: agents and writes are simulated (nothing is changed, nothing costs money); approvals are auto-approved
 * unless `testApprove: false`.
 */
async function start(vault, wfOrId, { trigger = {}, test = false, testApprove = true, by = 'you' } = {}, deps = {}) {
  const wf = typeof wfOrId === 'string' ? get(vault, wfOrId) : wfOrId;
  if (!wf) throw new Error('Workflow not found');
  const v = validate(wf); if (!v.ok) throw new Error(v.errors.join(' '));
  if (!test && wf.enabled === false) throw new Error('This workflow is turned off');
  const run = { id: rid('wfr'), workflow: wf.id || 'unsaved', name: wf.name, version: wf.version || 0, test: !!test, by, trigger, status: 'running', started: now(), finished: null, at: null, steps: [], agentRuns: 0, output: null, error: null, limits: { ...DEFAULT_LIMITS, ...(wf.limits || {}) }, testApprove };
  saveRun(vault, run);
  return advance(vault, run, wf, deps, null);
}

function ctxOf(run, wf) {
  const steps = {}; for (const s of run.steps) steps[s.node] = { output: s.output, ok: s.ok };
  const last = run.steps.length ? run.steps[run.steps.length - 1] : { output: '' };
  return { trigger: run.trigger || {}, last: { output: last.output }, steps, workflow: { name: wf.name }, today: new Date().toISOString().slice(0, 10) };
}

async function advance(vault, run, wf, deps, fromNode) {
  const byId = Object.fromEntries(wf.nodes.map((n) => [n.id, n]));
  const queue = fromNode ? [...fromNode] : [wf.nodes.find((n) => n.type === 'trigger').id];
  const t0 = Date.parse(run.started);
  while (queue.length) {
    const id = queue.shift(); const node = byId[id]; if (!node) continue;
    if (run.steps.length >= run.limits.maxSteps) return finish(vault, run, 'stopped', `Stopped at the limit of ${run.limits.maxSteps} steps (the workflow may loop).`);
    if (Date.now() - t0 > run.limits.maxMinutes * 60000) return finish(vault, run, 'stopped', `Stopped at the time limit of ${run.limits.maxMinutes} minutes.`);
    const ctx = ctxOf(run, wf); const c = node.config || {};
    const step = { node: id, type: node.type, started: now(), ok: true, output: '', note: '' };
    let branch = 'next';
    try {
      switch (node.type) {
        case 'trigger': step.output = run.trigger.title || run.trigger.question || run.trigger.text || ''; step.note = `Started (${c.on || 'manual'})`; break;
        case 'agent': {
          if (run.agentRuns >= run.limits.maxAgentRuns) throw Object.assign(new Error(`Agent run limit reached (${run.limits.maxAgentRuns}).`), { stop: true });
          run.agentRuns++;
          const prompt = fill(c.prompt, ctx);
          if (run.test) { step.output = `[test] An agent would be asked: ${prompt.slice(0, 300)}`; step.note = `Simulated ${c.tool || 'claude'}${c.model ? ` (${c.model})` : ''}`; break; }
          if (!deps.launchAgent) throw new Error('Agents can\'t run here');
          const r = await deps.launchAgent({ prompt, tool: c.tool || 'claude', model: c.model, project: fill(c.project || '', ctx) || run.trigger.project, task: run.trigger.id, maxMinutes: Math.min(Number(c.maxMinutes) || 30, run.limits.maxMinutes) });
          step.output = String(r.result || ''); step.runId = r.runId; step.ok = r.status === 'done';
          if (!step.ok) { step.note = `Agent ${r.status}: ${step.output.slice(0, 200)}`; if (!(node.else || []).length) throw new Error(step.note); branch = 'else'; }
          break;
        }
        case 'tool': step.output = await runTool(vault, c, ctx, run.test, deps); step.note = `${c.name}${run.test && /write|update/.test(c.name) ? ' (simulated)' : ''}`; break;
        case 'condition': { const yes = check(c, ctx); step.output = ctx.last.output; step.note = yes ? 'Yes' : 'No'; branch = yes ? 'next' : 'else'; break; }
        case 'approval': {
          const msg = fill(c.message || 'Approve to continue', ctx);
          if (run.test) { step.output = ctx.last.output; step.note = run.testApprove ? `[test] Approved: ${msg.slice(0, 160)}` : `[test] Rejected: ${msg.slice(0, 160)}`; branch = run.testApprove ? 'next' : 'else'; break; }
          step.note = `Waiting for your approval: ${msg.slice(0, 300)}`; step.output = ctx.last.output; step.waiting = true;
          run.steps.push(step); run.status = 'waiting'; run.at = id; run.waitingMessage = msg; run.pending = queue; saveRun(vault, run);
          try { deps.notify && deps.notify(vault, { kind: 'approval', title: `Workflow "${wf.name}" needs your approval`, body: msg.slice(0, 300), ref: run.id, key: 'wf|' + run.id }); } catch { /* optional */ }
          return run;
        }
        case 'task': {
          const data = { title: fill(c.title, ctx).slice(0, 200), body: fill(c.body || '', ctx) }; const proj = fill(c.project || '', ctx) || run.trigger.project; if (proj) data.project = proj; if (c.priority) data.priority = c.priority;
          if (run.test) { step.output = `[test] Would create task "${data.title}"`; break; }
          const t = deps.store.create('task', data); step.output = t.id; step.note = `Created task "${t.title}"`; break;
        }
        case 'notify': {
          const n = { kind: 'done', title: fill(c.title, ctx).slice(0, 200), body: fill(c.body || '', ctx).slice(0, 1000), key: `wf|${run.id}|${id}` };
          if (run.test) { step.output = `[test] Would notify: ${n.title}`; break; }
          deps.notify && deps.notify(vault, n); step.output = n.title; break;
        }
        case 'output': {
          const out = ctx.last.output; run.output = out;
          if (c.save === 'memory') {
            const title = fill(c.title || `${wf.name} result {{today}}`, ctx).slice(0, 150);
            if (run.test) step.note = `[test] Would save memory "${title}"`;
            else { const m = deps.store.create('note', { title, body: out, ...((fill(c.project || '', ctx) || run.trigger.project) ? { project: fill(c.project || '', ctx) || run.trigger.project } : {}), tags: ['workflow'] }); step.note = `Saved memory "${m.title}"`; }
          }
          step.output = out; break;
        }
        default: throw new Error(`Unknown step type ${node.type}`);
      }
    } catch (e) {
      step.ok = false; step.note = e.message; step.finished = now(); run.steps.push(step);
      return finish(vault, run, e.stop ? 'stopped' : 'failed', `${id}: ${e.message}`);
    }
    step.finished = now(); run.steps.push(step); saveRun(vault, run);
    queue.push(...((branch === 'else' ? node.else : node.next) || []));
  }
  return finish(vault, run, 'done');
}

async function runTool(vault, c, ctx, test, deps) {
  const store = deps.store;
  if (c.name === 'memory_search') {
    const q = fill(c.query || '', ctx).trim(); if (!q) return '';
    const hits = store.search ? store.search(q, { limit: Number(c.limit) || 5 }) : [];
    return (hits || []).map((h) => { const r = h.rec || h; return `${r.title || r.id}: ${String(h.snippet || r.body || '').replace(/\s+/g, ' ').slice(0, 200)}`; }).join('\n');
  }
  if (c.name === 'project_brief') {
    const p = fill(c.project || '', ctx).trim(); if (!p) return '';
    try { return require('./brief').buildBrief(store, { project: p }).text.slice(0, 12000); } catch (e) { return `No brief: ${e.message}`; }
  }
  if (c.name === 'memory_write') {
    const title = fill(c.title || 'Workflow note', ctx).slice(0, 150); const body = fill(c.content || '{{last.output}}', ctx);
    if (test) return `[test] Would save memory "${title}"`;
    return store.create('note', { title, body, ...(fill(c.project || '', ctx) ? { project: fill(c.project || '', ctx) } : {}), tags: ['workflow'] }).id;
  }
  if (c.name === 'task_update') {
    const id = fill(c.task || '{{trigger.id}}', ctx); const patch = {}; if (c.status) patch.status = c.status; if (c.priority) patch.priority = c.priority;
    if (test) return `[test] Would update ${id}: ${JSON.stringify(patch)}`;
    const t = store.get(id); if (!t) throw new Error(`Task not found: ${id}`);
    return store.update(t.id, patch).id;
  }
  throw new Error(`Tool not allowed: ${c.name}`);
}

function finish(vault, run, status, error = null) { run.status = status; run.error = error; run.finished = now(); run.at = null; run.pending = undefined; saveRun(vault, run); return run; }

/** Answer a waiting approval. */
async function decide(vault, runId, approve, deps = {}, { by = 'you', note = '' } = {}) {
  const run = getRun(vault, runId); if (!run) throw new Error('Run not found');
  if (run.status !== 'waiting') throw new Error('This run is not waiting for approval');
  const wf = get(vault, run.workflow); if (!wf) throw new Error('The workflow was deleted');
  const node = wf.nodes.find((n) => n.id === run.at);
  const step = run.steps[run.steps.length - 1]; step.waiting = false; step.note = `${approve ? 'Approved' : 'Rejected'} by ${by}${note ? `: ${String(note).slice(0, 300)}` : ''}`; step.finished = now();
  run.status = 'running'; run.waitingMessage = undefined;
  const pending = run.pending || []; run.pending = undefined; saveRun(vault, run);
  const nextIds = (approve ? node.next : node.else) || [];
  if (!approve && !nextIds.length && !pending.length) return finish(vault, run, 'stopped', `Rejected by ${by}`);
  return advance(vault, run, wf, deps, [...pending, ...nextIds]);
}

function cancel(vault, runId, by = 'you') { const run = getRun(vault, runId); if (!run) throw new Error('Run not found'); if (['done', 'failed', 'stopped'].includes(run.status)) return run; return finish(vault, run, 'stopped', `Cancelled by ${by}`); }

// ---------------- triggers ----------------
/** Workflows that start on this event (task.created / task.done). */
function matching(vault, event, item) {
  return list(vault).filter((wf) => wf.enabled !== false).filter((wf) => {
    const t = wf.nodes.find((n) => n.type === 'trigger'); const c = (t && t.config) || {};
    if (c.on !== event) return false;
    if (c.project && item && item.project !== c.project) return false;
    return true;
  });
}
/** Scheduled workflows that are due. `last` maps workflow id → last start ms. */
function due(vault, last = {}, at = Date.now()) {
  return list(vault).filter((wf) => wf.enabled !== false).filter((wf) => {
    const t = wf.nodes.find((n) => n.type === 'trigger'); const c = (t && t.config) || {};
    return c.on === 'schedule' && Number(c.everyMinutes) >= 5 && at - (last[wf.id] || 0) >= Number(c.everyMinutes) * 60000;
  });
}

module.exports = { NODE_TYPES, TRIGGERS, TOOLS, OPS, DEFAULT_LIMITS, TEMPLATES, validate, list, get, save, remove, runs, getRun, start, decide, cancel, matching, due, fill, check };
