'use strict';
// Agent jobs: a request to run Claude Code or Codex on one of the user's computers ("local" = the computer running
// this Cortex, or a paired computer's device id). Requests from AI agents wait for the user's approval.
// Guards: allowlisted tools, duplicate prevention, a launch rate limit, and an audit trail in the activity log.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOOLS = ['claude', 'codex'];
const ACTIVE = ['needs-approval', 'queued', 'running'];
const RATE = { max: 10, windowMs: 10 * 60 * 1000 };

const dir = (vault) => path.join(vault, '.cortex', 'jobs');
const fileOf = (vault, id) => path.join(dir(vault), String(id).replace(/[^\w-]/g, '') + '.json');

function save(vault, j) {
  fs.mkdirSync(dir(vault), { recursive: true });
  const f = fileOf(vault, j.id);
  fs.writeFileSync(f + '.tmp', JSON.stringify(j, null, 2));
  fs.renameSync(f + '.tmp', f);
  return j;
}
function get(vault, id) { try { return JSON.parse(fs.readFileSync(fileOf(vault, id), 'utf8')); } catch { return null; } }
function list(vault, { limit = 50 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir(vault)).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => get(vault, n.slice(0, -5))).filter(Boolean).sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, limit);
}

/**
 * Create a job. `needsApproval` for requests from AI agents. Throws (with a plain reason) on bad input,
 * a duplicate of an active job, or too many launches in 10 minutes.
 */
function create(vault, { device = 'local', deviceName, tool = 'claude', model, prompt, project, task, from = 'you', needsApproval = false }) {
  if (!TOOLS.includes(tool)) throw new Error(`Unknown agent tool "${tool}". Use claude or codex.`);
  prompt = String(prompt || '').trim().slice(0, 8000);
  if (!prompt && !task) throw new Error('Say what the agent should do');
  if (model && !/^[\w.:\-[\]]{1,60}$/.test(String(model))) throw new Error('Invalid model name');
  if (!/^(local|dev-[a-f0-9]{10})$/.test(device)) throw new Error('Unknown computer');
  const all = list(vault, { limit: 500 });
  const now = Date.now();
  const recent = all.filter((j) => now - Date.parse(j.created) < RATE.windowMs && j.status !== 'rejected');
  if (recent.length >= RATE.max) throw new Error(`Too many agent launches (${RATE.max} in 10 minutes). Wait a few minutes.`);
  const key = `${device}|${tool}|${project || ''}|${task || ''}|${prompt.toLowerCase().replace(/\s+/g, ' ')}`;
  const dup = all.find((j) => ACTIVE.includes(j.status) && j.key === key);
  if (dup) { const e = new Error(`The same job is already ${dup.status === 'needs-approval' ? 'waiting for approval' : dup.status} (${dup.id}).`); e.code = 'DUPLICATE'; e.job = dup; throw e; }
  const j = {
    id: 'job-' + crypto.randomBytes(5).toString('hex'), key, device, deviceName: deviceName || (device === 'local' ? 'This computer' : device),
    tool, model: model || undefined, prompt, project: project || undefined, task: task || undefined, from,
    status: needsApproval ? 'needs-approval' : 'queued', step: needsApproval ? `Waiting for your OK (asked by ${from})` : 'Queued',
    created: new Date().toISOString(),
  };
  return save(vault, j);
}

function patch(vault, id, p) { const j = get(vault, id); if (!j) throw new Error('Job not found'); Object.assign(j, p, { updated: new Date().toISOString() }); return save(vault, j); }
function approve(vault, id) { const j = get(vault, id); if (!j) throw new Error('Job not found'); if (j.status !== 'needs-approval') return j; return patch(vault, id, { status: 'queued', step: 'Approved: queued', approvedAt: new Date().toISOString() }); }
function reject(vault, id) { const j = get(vault, id); if (!j) throw new Error('Job not found'); if (j.status !== 'needs-approval') return j; return patch(vault, id, { status: 'rejected', step: 'Declined by you' }); }
function requestStop(vault, id) {
  const j = get(vault, id); if (!j) throw new Error('Job not found');
  if (j.status === 'queued' || j.status === 'needs-approval') return patch(vault, id, { status: 'stopped', step: 'Cancelled by you' });
  if (j.status === 'running') return patch(vault, id, { stopRequested: true, step: 'Stopping…' });
  return j;
}

/** A paired computer asks for its next job: the oldest queued job for it, marked running. */
function claimNext(vault, deviceId) {
  const j = list(vault, { limit: 500 }).filter((x) => x.device === deviceId && x.status === 'queued').sort((a, b) => (a.created < b.created ? -1 : 1))[0];
  if (!j) return null;
  return patch(vault, j.id, { status: 'running', step: 'Starting on the computer…', startedAt: new Date().toISOString() });
}

/** Progress from the computer running the job. Only the device that owns the job may update it. */
function report(vault, deviceId, id, { status, step, result, cost_usd, error }) {
  const j = get(vault, id);
  if (!j || j.device !== deviceId) throw new Error('Job not found');
  if (!['running', 'done', 'error', 'stopped'].includes(status || 'running')) throw new Error('Invalid status');
  if (!['running'].includes(j.status)) return j; // already finished or cancelled
  return patch(vault, id, { status: status || 'running', step: String(step || j.step || '').slice(0, 300), ...(result !== undefined ? { result: String(result).slice(0, 4000) } : {}), ...(cost_usd !== undefined ? { cost_usd: Number(cost_usd) || 0 } : {}), ...(error ? { error: String(error).slice(0, 500) } : {}), ...(status && status !== 'running' ? { finishedAt: new Date().toISOString() } : {}) });
}

module.exports = { create, get, list, patch, approve, reject, requestStop, claimNext, report, TOOLS, RATE };
