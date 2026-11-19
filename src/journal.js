'use strict';
// The agent journal: notes/<project>/agent-journal.md (project work) or notes/agent-journal.md (no project).
// Cortex itself appends to it — from Claude Code hooks, launched runs and every agent action that touches a
// project — so there is always a record of what agents did, whether or not the agent remembered to write one.
// Plain file appends (no Store needed), so separate processes (hooks, MCP servers, dashboard) can all write.
const fs = require('fs');
const path = require('path');
const { parse } = require('./frontmatter');

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const hhmm = (d = new Date()) => d.toTimeString().slice(0, 5);
const safe = (s) => String(s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 80);

function projectTitle(vault, project) {
  try { const { meta } = parse(fs.readFileSync(path.join(vault, 'projects', project + '.md'), 'utf8')); return meta.title || project; } catch { return null; }
}

function fileFor(vault, project) {
  return project ? path.join(vault, 'notes', safe(project), 'agent-journal.md') : path.join(vault, 'notes', 'agent-journal.md');
}

function ensure(vault, project) {
  const f = fileFor(vault, project);
  if (fs.existsSync(f)) return f;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const title = project ? `Agent journal: ${projectTitle(vault, project) || project}` : 'Agent journal: general';
  const ts = new Date().toISOString();
  fs.writeFileSync(f, `---\ntitle: ${JSON.stringify(title)}\ntype: log\n${project ? `project: ${safe(project)}\n` : ''}agent_journal: ${project ? safe(project) : 'general'}\ntags: [agent-journal]\ncreated: "${ts}"\nupdated: "${ts}"\n---\n\n# ${title}\n\nWritten automatically by Cortex: every agent session, run and action on ${project ? 'this project' : 'work outside a project'} is recorded here, newest at the bottom.\n`);
  return f;
}

function append(vault, project, markdown) {
  if (project && !fs.existsSync(path.join(vault, 'projects', safe(project) + '.md'))) project = undefined;
  const f = ensure(vault, project);
  const text = fs.readFileSync(f, 'utf8');
  const head = `\n## ${day()}\n`;
  let out = text.includes(head) ? '' : head;
  out += markdown.endsWith('\n') ? markdown : markdown + '\n';
  // keep the front-matter "updated" fresh so the vault shows the journal as recently changed
  const updated = text.replace(/^updated: .*$/m, `updated: "${new Date().toISOString()}"`);
  fs.writeFileSync(f, updated + out);
  return f;
}

/** One-line entry for an individual action. */
function line(vault, project, agent, summary) {
  return append(vault, project, `- ${hhmm()} · **${agent}** · ${String(summary).replace(/\s+/g, ' ').slice(0, 300)}`);
}

/** Full entry for a finished session or run. */
function session(vault, project, { agent, title, outcome, status, files = [], commands = 0, savedMemory, source }) {
  const lines = [
    `\n### ${hhmm()} · ${agent} · ${status === 'error' ? '✗ failed' : status === 'stopped' ? '■ stopped' : '✓ finished'}${source ? ` (${source})` : ''}`,
    title ? `**Asked:** ${String(title).replace(/\s+/g, ' ').slice(0, 400)}` : '',
    files.length ? `**Changed:** ${[...new Set(files)].slice(0, 20).map((x) => '`' + x + '`').join(', ')}${files.length > 20 ? ` and ${files.length - 20} more` : ''}` : '',
    commands ? `**Commands run:** ${commands}` : '',
    savedMemory === undefined ? '' : `**Saved to memory:** ${savedMemory ? 'yes' : 'no'}`,
    `**Outcome:** ${String(outcome || '(no summary given)').trim().slice(0, 2500)}`,
  ].filter(Boolean);
  return append(vault, project, lines.join('\n') + '\n');
}

/** Which project does a working folder belong to? (project "folder" field, or folder name = project slug) */
function projectForFolder(vault, cwd) {
  if (!cwd) return undefined;
  const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const c = norm(cwd);
  let best;
  let bestLen = 0;
  let files = [];
  try { files = fs.readdirSync(path.join(vault, 'projects')).filter((f) => f.endsWith('.md')); } catch { return undefined; }
  for (const f of files) {
    const slug = f.slice(0, -3);
    let meta = {};
    try { meta = parse(fs.readFileSync(path.join(vault, 'projects', f), 'utf8')).meta; } catch { continue; }
    if (meta.status === 'archived') continue;
    if (meta.folder) {
      const p = norm(meta.folder);
      if ((c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + '/')) && p.length > bestLen) { best = slug; bestLen = p.length; }
    }
  }
  if (best) return best;
  const base = path.basename(cwd).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return files.some((f) => f === base + '.md') ? base : undefined;
}

module.exports = { append, line, session, projectForFolder, fileFor };
