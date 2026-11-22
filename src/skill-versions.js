'use strict';
// Skill evolution (2.2 #8): version history, usage and results per version, compatible models, sources,
// candidate versions that must beat (or match) the current default before replacing it, and rollback.
// Acceptance rule: a candidate becomes the default when it has ≥ 3 reports and its "helped" rate (partly = half) is at
// least the default's (or the default has no reports yet). The user can promote or roll back any version by hand.
const fs = require('fs');
const path = require('path');

const MIN_N = 3;
const dir = (vault, slug) => { if (!/^[\w-]{1,100}$/.test(slug)) throw new Error('bad skill name'); const d = path.join(vault, '.cortex', 'skills-history', slug); fs.mkdirSync(d, { recursive: true }); return d; };
const metaFile = (vault, slug) => path.join(dir(vault, slug), 'versions.json');
const load = (vault, slug) => { try { return JSON.parse(fs.readFileSync(metaFile(vault, slug), 'utf8')); } catch { return { current: null, versions: [] }; } };
const save = (vault, slug, m) => { const f = metaFile(vault, slug); fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1)); fs.renameSync(f + '.tmp', f); };
const rate = (v) => { const f = v.feedback || {}; const n = (f.helped || 0) + (f.partly || 0) + (f.didnt_help || 0); return { n, value: n ? ((f.helped || 0) + (f.partly || 0) * 0.5) / n : null }; };
const view = (v, cur) => ({ version: v.version, status: v.version === cur ? 'default' : v.status, by: v.by, at: v.at, note: v.note, uses: v.uses || 0, feedback: v.feedback || {}, helpedRate: rate(v), models: v.models || [], sources: v.sources || [] });

/** Make sure the skill's current text is recorded as a version (first time we see the skill). */
function ensure(store, rec) {
  const m = load(store.vault, rec.slug);
  if (!m.versions.length) { m.versions.push({ version: 1, status: 'default', body: rec.body, description: rec.meta.description || '', by: rec.meta.author || 'you', at: rec.created || new Date().toISOString(), uses: 0, feedback: {} }); m.current = 1; save(store.vault, rec.slug, m); }
  return m;
}

/**
 * Save a new version. From the user ("you") it becomes the default straight away (as before); from an agent it is a
 * candidate unless the skill is brand new or `asDefault` is set by the user.
 */
function saveVersion(store, { title, description, instructions, by = 'you', note = '', sources = [], asDefault }) {
  const existing = store.list('skill').find((r) => r.title.toLowerCase() === String(title).toLowerCase());
  if (!existing) {
    const r = store.create('skill', { title, description, body: instructions, author: by });
    const m = ensure(store, r); m.versions[0].sources = sources.slice(0, 10); m.versions[0].note = note; save(store.vault, r.slug, m);
    return { rec: r, version: 1, status: 'default', created: true };
  }
  const m = ensure(store, existing);
  if (m.versions.some((v) => v.body === instructions && v.description === description)) return { rec: existing, version: m.versions.find((v) => v.body === instructions).version, status: 'unchanged' };
  const version = Math.max(...m.versions.map((v) => v.version)) + 1;
  const isDefault = asDefault !== undefined ? asDefault : by === 'you';
  m.versions.push({ version, status: isDefault ? 'default' : 'candidate', body: instructions, description, by, note: String(note).slice(0, 400), sources: sources.slice(0, 10), at: new Date().toISOString(), uses: 0, feedback: {} });
  if (isDefault) { for (const v of m.versions) if (v.version !== version && v.status === 'default') v.status = 'previous'; m.current = version; store.update(existing.id, { description, body: instructions, skill_version: version }); }
  save(store.vault, existing.slug, m);
  return { rec: store.get(existing.id), version, status: isDefault ? 'default' : 'candidate' };
}

/** The text an agent should use: the default, or (for evaluation) a candidate on every other use. */
function forUse(store, rec, { model } = {}) {
  const m = ensure(store, rec);
  const cur = m.versions.find((v) => v.version === m.current) || m.versions[0];
  const cand = m.versions.filter((v) => v.status === 'candidate').sort((a, b) => b.version - a.version)[0];
  const total = m.versions.reduce((n, v) => n + (v.uses || 0), 0);
  const pick = cand && total % 2 === 1 ? cand : cur; // alternate, so both collect evidence on similar work
  pick.uses = (pick.uses || 0) + 1;
  if (model && !(pick.usedBy || []).includes(model)) pick.usedBy = [...(pick.usedBy || []), model].slice(-10);
  save(store.vault, rec.slug, m);
  return { version: pick.version, status: pick === cur ? 'default' : 'candidate', body: pick.body, description: pick.description };
}

/** Record how a version worked; promotes a candidate that meets the acceptance rule. */
function feedback(store, slug, { version, result, model, note }) {
  if (!['helped', 'partly', 'didnt_help'].includes(result)) throw new Error('result must be helped, partly or didnt_help');
  const rec = store.must('skills/' + slug);
  const m = ensure(store, rec);
  const v = version ? m.versions.find((x) => x.version === Number(version)) : m.versions.find((x) => x.version === m.current);
  if (!v) throw new Error('Unknown version');
  v.feedback = v.feedback || {}; v.feedback[result] = (v.feedback[result] || 0) + 1;
  if (result === 'helped' && model && !(v.models || []).includes(model)) v.models = [...(v.models || []), model].slice(-10);
  if (note) v.notes = [...(v.notes || []), String(note).slice(0, 200)].slice(-10);
  let promoted = null;
  const cur = m.versions.find((x) => x.version === m.current);
  if (v.status === 'candidate') {
    const rc = rate(v); const rd = rate(cur || {});
    if (rc.n >= MIN_N && (rd.n === 0 || rc.value >= rd.value)) { promoted = v.version; v.status = 'default'; if (cur) cur.status = 'previous'; m.current = v.version; store.update(rec.id, { description: v.description, body: v.body, skill_version: v.version }); }
    else if (rc.n >= MIN_N * 2 && rd.n >= MIN_N && rc.value < rd.value) v.status = 'rejected'; // clearly worse: stop testing it
  }
  save(store.vault, slug, m);
  return { version: v.version, promoted, helpedRate: rate(v) };
}

function setDefault(store, slug, version) {
  const rec = store.must('skills/' + slug); const m = ensure(store, rec);
  const v = m.versions.find((x) => x.version === Number(version)); if (!v) throw new Error('Unknown version');
  for (const x of m.versions) if (x.status === 'default') x.status = 'previous';
  v.status = 'default'; m.current = v.version;
  store.update(rec.id, { description: v.description, body: v.body, skill_version: v.version });
  save(store.vault, slug, m);
  return view(v, m.current);
}
function list(store, slug) { const rec = store.must('skills/' + slug); const m = ensure(store, rec); return { name: slug, current: m.current, versions: m.versions.map((v) => view(v, m.current)).reverse() }; }

module.exports = { saveVersion, forUse, feedback, setDefault, list, MIN_N };
