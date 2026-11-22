'use strict';
// Timeline (2.2 #36), feedback (#39) and user preferences (#14). Deterministic; nothing personal beyond how the user
// uses Cortex; every learned preference is visible and can be forgotten.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPE = (action) => { const a = String(action || ''); return /^agent|^run|^job/.test(a) ? 'agents' : /^task/.test(a) ? 'tasks' : /^memory|^note/.test(a) ? 'memory' : /^smartsave|backup/.test(a) ? 'saves' : /^device/.test(a) ? 'devices' : /^fetcher|^mind|^lesson/.test(a) ? 'research' : /setting|doctor|emergency|update|hooks|connector/.test(a) ? 'system' : 'other'; };

function timeline(store, { project, agent, device, type, q, limit = 100 } = {}) {
  const ql = String(q || '').toLowerCase();
  const out = [];
  for (let i = store.activity.length - 1; i >= 0 && out.length < limit; i--) {
    const e = store.activity[i]; const t = TYPE(e.action);
    if (project && e.project !== project) continue;
    if (agent && e.agent !== agent) continue;
    if (device && (e.device || 'This computer') !== device) continue;
    if (type && t !== type) continue;
    if (ql && !`${e.summary} ${e.agent} ${e.action}`.toLowerCase().includes(ql)) continue;
    out.push({ ...e, type: t, result: /fail|error|declined|rejected|stopped/i.test(`${e.action} ${e.summary}`) ? 'problem' : 'ok' });
  }
  const recent = store.activity.slice(-2000);
  return { items: out, filters: { projects: [...new Set(recent.map((e) => e.project).filter(Boolean))], agents: [...new Set(recent.map((e) => e.agent))].slice(0, 40), devices: [...new Set(['This computer', ...recent.map((e) => e.device).filter(Boolean)])], types: ['agents', 'tasks', 'memory', 'saves', 'devices', 'research', 'system', 'other'] } };
}

// ---------- feedback ----------
const ffile = (vault) => path.join(vault, '.cortex', 'feedback.json');
function addFeedback(store, { about, rating, text, ref }, who = 'you') {
  if (!['up', 'down'].includes(rating) && !text) throw new Error('Give a thumbs up/down or write something');
  let all = []; try { all = JSON.parse(fs.readFileSync(ffile(store.vault), 'utf8')); } catch { /* first */ }
  const f = { id: 'fb-' + crypto.randomBytes(4).toString('hex'), about: String(about || 'general').slice(0, 60), rating: rating || null, text: require('./redact').redact(String(text || ''), store.vault).slice(0, 1000), ref: ref || null, by: who, at: new Date().toISOString() };
  all.push(f); fs.mkdirSync(path.dirname(ffile(store.vault)), { recursive: true }); fs.writeFileSync(ffile(store.vault), JSON.stringify(all.slice(-1000)));
  // three or more thumbs-down about the same thing → an improvement proposal (it still has to be tested before it applies)
  let proposal = null;
  const downs = all.filter((x) => x.about === f.about && x.rating === 'down');
  if (f.rating === 'down' && downs.length >= 3) {
    const total = all.filter((x) => x.about === f.about && x.rating).length;
    proposal = require('./intel').engine.propose(store.vault, { title: `Users are unhappy with: ${f.about}`, kind: 'ux', change: `Feedback (${downs.length} thumbs down): ${downs.slice(-5).map((x) => x.text).filter(Boolean).join(' | ') || 'no comments'}. Investigate and fix; measure the thumbs-down share again after the change.`, baseline: { metric: 'thumbs-down share', value: +(downs.length / total).toFixed(2), n: total }, higherIsBetter: false, from: 'user feedback' });
  }
  return { feedback: f, proposal };
}
function listFeedback(vault) { try { return JSON.parse(fs.readFileSync(ffile(vault), 'utf8')).reverse(); } catch { return []; } }

// ---------- preferences ----------
function preferences(store, settings) {
  const forgotten = new Set(((settings.preferences || {}).forgotten) || []);
  const explicit = store.list('note').filter((n) => !n.meta.project && (n.allTags || []).some((t) => /^(preferences?|workflow|style)$/.test(t)) || /prefer|preference|working style/i.test(n.title)).slice(0, 30).map((n) => ({ id: n.id, title: n.title, updated: n.updated }));
  const recent = store.activity.slice(-3000).filter((e) => e.agent === 'you' || e.agent === 'you (phone)');
  const count = (xs) => Object.entries(xs.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const learned = [];
  const topProjects = count(recent.map((e) => e.project).filter(Boolean)).slice(0, 3);
  if (topProjects.length) learned.push({ key: 'top-projects', label: 'Projects you work on most', value: topProjects.map(([p, n]) => `${p} (${n})`).join(', '), source: 'your activity (last 3,000 events)' });
  const phone = recent.filter((e) => e.agent === 'you (phone)').length;
  if (recent.length > 20) learned.push({ key: 'device-use', label: 'Where you use Cortex', value: `${Math.round((phone / recent.length) * 100)}% from your phone`, source: 'your activity' });
  const sess = require('./sessions').list(store.vault).filter((s) => s.model);
  const models = count(sess.map((s) => require('./intel').modelFamily(s.model))).slice(0, 3);
  if (models.length) learned.push({ key: 'models', label: 'Models your agents use most', value: models.map(([m, n]) => `${m} (${n})`).join(', '), source: 'recorded agent runs' });
  const fb = listFeedback(store.vault);
  const downs = count(fb.filter((f) => f.rating === 'down').map((f) => f.about)).slice(0, 3);
  if (downs.length) learned.push({ key: 'dislikes', label: 'Things you gave a thumbs down', value: downs.map(([a, n]) => `${a} (${n})`).join(', '), source: 'your feedback' });
  learned.push({ key: 'interface', label: 'Interface', value: `${(settings.ui || {}).mode || 'advanced'} mode${((settings.ui || {}).hidePanels || []).length ? `, ${settings.ui.hidePanels.length} panels hidden` : ''}; model routing: ${(settings.routing || {}).mode || 'suggest'}`, source: 'your settings' });
  return { explicit, learned: learned.filter((l) => !forgotten.has(l.key)), forgotten: [...forgotten], note: 'Cortex only learns from how you use Cortex (activity, settings, feedback, agent runs). It does not read your chats for this. Forget anything here and it stops being shown or used.' };
}

module.exports = { timeline, addFeedback, listFeedback, preferences, TYPE };
