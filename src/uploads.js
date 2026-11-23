'use strict';
// Drag-and-drop files (2.2 #31) and UX intelligence (#42).
// Uploads: size limit, allow-listed types only (no programs or scripts that could run), secret check for text,
// safe file names, stored in the vault under attachments/<project>/ and linked from a note or task.
// UX metrics: only with the user's permission; only counts and durations (which page, which button, how many steps,
// errors) — never typed text, memory content or conversations.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 10 * 1024 * 1024;
const OK_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.lua', '.luau', '.java', '.cs', '.go', '.rs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.lua', '.luau', '.java', '.cs', '.go', '.rs', '.svg']);

function save(store, { name, data, project, task }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('Empty file');
  if (data.length > MAX) throw new Error('Files can be up to 10 MB');
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!OK_EXT.has(ext)) throw new Error(`"${ext || 'no extension'}" files aren't accepted (allowed: text, code, Markdown, images, PDF)`);
  if (TEXT_EXT.has(ext)) { const s = require('./smartsave/scan').secretIn(data); if (s) throw new Error(`This file contains ${s}; it was not uploaded. Remove the secret first.`); }
  const safe = path.basename(String(name)).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file' + ext;
  const slug = project ? store.resolveProject(project) : 'inbox';
  const dir = path.join(store.vault, 'attachments', slug); fs.mkdirSync(dir, { recursive: true });
  const fname = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}-${safe}`;
  fs.writeFileSync(path.join(dir, fname), data);
  const rel = `attachments/${slug}/${fname}`;
  const preview = TEXT_EXT.has(ext) ? data.toString('utf8').slice(0, 1500) : null;
  const link = `[${safe}](${rel})`;
  if (task) store.update(store.must(task).id, { append: `**Attached:** ${link}${preview ? `\n\n\`\`\`\n${preview.slice(0, 600)}\n\`\`\`` : ''}` });
  else store.create('note', { title: `File: ${safe}`, project: slug === 'inbox' ? undefined : slug, tags: ['attachment'], body: `${link}\n\n${preview ? '```\n' + preview + '\n```' : ext === '.pdf' ? 'PDF attached.' : `![${safe}](${rel})`}` });
  return { path: rel, name: safe, size: data.length, preview: preview ? preview.slice(0, 300) : null, image: /\.(png|jpe?g|gif|webp|svg)$/.test(ext) };
}

// ---------- UX intelligence ----------
const uxFile = (vault) => path.join(vault, '.cortex', 'ux.json');
const ALLOWED_EVENTS = /^(page|click|error|flow-start|flow-end|command)$/;
function uxRecord(vault, events) {
  let d; try { d = JSON.parse(fs.readFileSync(uxFile(vault), 'utf8')); } catch { d = { pages: {}, clicks: {}, errors: {}, flows: {}, commands: { ok: 0, unknown: 0 }, since: new Date().toISOString() }; }
  for (const e of (events || []).slice(0, 200)) {
    if (!ALLOWED_EVENTS.test(e.type)) continue;
    const k = String(e.key || '').replace(/[^\w#/.:-]/g, '').slice(0, 60); // ids and routes only: never text
    if (e.type === 'page') d.pages[k] = (d.pages[k] || 0) + 1;
    if (e.type === 'click') d.clicks[k] = (d.clicks[k] || 0) + 1;
    if (e.type === 'error') d.errors[k] = (d.errors[k] || 0) + 1;
    if (e.type === 'command') d.commands[e.ok ? 'ok' : 'unknown']++;
    if (e.type === 'flow-end' && Number.isFinite(e.ms)) { const f = d.flows[k] || (d.flows[k] = { n: 0, ms: 0, steps: 0 }); f.n++; f.ms += Math.min(e.ms, 3600e3); f.steps += Math.min(Number(e.steps) || 0, 200); }
  }
  fs.mkdirSync(path.dirname(uxFile(vault)), { recursive: true }); fs.writeFileSync(uxFile(vault), JSON.stringify(d));
  return { ok: true };
}
const FEATURES = { 'cc-panel': 'command box', 'sc-add': 'shortcuts', 'in-scan': 'pattern scan', 'dv-add': 'device pairing', 'ss-now': 'SmartSave Save now', 'pm-stop': 'emergency stop', 'rs-panel': 'continue unfinished work', 'jb-form': 'start an agent' };
function uxReport(vault) {
  let d; try { d = JSON.parse(fs.readFileSync(uxFile(vault), 'utf8')); } catch { return { measuring: false, suggestions: [] }; }
  const flows = Object.fromEntries(Object.entries(d.flows).map(([k, f]) => [k, { runs: f.n, avgSeconds: +(f.ms / f.n / 1000).toFixed(1), avgSteps: +(f.steps / f.n).toFixed(1) }]));
  const s = [];
  const unused = Object.entries(FEATURES).filter(([k]) => !d.clicks[k]).map(([, v]) => v);
  if (unused.length) s.push(`Never used yet: ${unused.join(', ')}. If they're hard to find, they may need a better place.`);
  for (const [k, f] of Object.entries(flows)) if (f.avgSteps > 6) s.push(`"${k}" takes ${f.avgSteps} steps on average: a shortcut or fewer screens could help.`);
  const errs = Object.entries(d.errors).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (errs.length) s.push(`Most frequent errors: ${errs.map(([k, n]) => `${k} (${n})`).join(', ')}.`);
  if (d.commands.unknown > d.commands.ok && d.commands.unknown >= 3) s.push(`The command box misunderstood ${d.commands.unknown} of ${d.commands.ok + d.commands.unknown} requests: more phrasings should be supported.`);
  return { measuring: true, since: d.since, topPages: Object.entries(d.pages).sort((a, b) => b[1] - a[1]).slice(0, 6), flows, errors: d.errors, commands: d.commands, suggestions: s };
}

module.exports = { save, uxRecord, uxReport, MAX, OK_EXT };
