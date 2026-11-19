'use strict';
// Put the Cortex agent prompt into the user's personal instruction files so every session uses it:
//   Claude Code → ~/.claude/CLAUDE.md   (user memory, loaded in every project)
//   Codex       → ~/.codex/AGENTS.md
// Cortex only manages its own marked block. Everything else in those files is left exactly as it is,
// and the original file is backed up (<file>.cortex-backup) the first time Cortex changes it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENT_PROMPT } = require('./snippets');

const START = '<!-- cortex:start: managed by Cortex (cortex setup). Edit outside this block; changes inside are replaced. -->';
const END = '<!-- cortex:end -->';
const TARGETS = {
  'claude-code': { label: 'Claude Code', dir: () => path.join(os.homedir(), '.claude'), file: 'CLAUDE.md' },
  codex: { label: 'Codex', dir: () => path.join(os.homedir(), '.codex'), file: 'AGENTS.md' },
};

const block = () => `${START}\n## Cortex\n\n${AGENT_PROMPT}\n${END}`;
const BLOCK_RE = /\n*<!-- cortex:start[\s\S]*?<!-- cortex:end -->\n*/;

function fileFor(target) { const t = TARGETS[target]; return path.join(t.dir(), t.file); }

function install(target) {
  const t = TARGETS[target];
  if (!fs.existsSync(t.dir())) return { target, skipped: true, reason: `${t.label} not installed` };
  const f = fileFor(target);
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur && !fs.existsSync(f + '.cortex-backup') && !BLOCK_RE.test(cur)) fs.copyFileSync(f, f + '.cortex-backup');
  const rest = cur.replace(BLOCK_RE, '\n').trim();
  const next = (rest ? rest + '\n\n' : '') + block() + '\n';
  if (next !== cur) fs.writeFileSync(f, next);
  return { target, file: f, changed: next !== cur };
}

function uninstall(target) {
  const f = fileFor(target);
  if (!fs.existsSync(f)) return { target, removed: false };
  const cur = fs.readFileSync(f, 'utf8');
  if (!BLOCK_RE.test(cur)) return { target, removed: false };
  const rest = cur.replace(BLOCK_RE, '\n').trim();
  fs.writeFileSync(f, rest ? rest + '\n' : '');
  return { target, removed: true };
}

function status() {
  const out = {};
  for (const k of Object.keys(TARGETS)) {
    const f = fileFor(k);
    out[k] = fs.existsSync(f) && BLOCK_RE.test(fs.readFileSync(f, 'utf8')) ? (fs.readFileSync(f, 'utf8').includes(AGENT_PROMPT) ? 'installed' : 'outdated') : 'not installed';
  }
  return out;
}

module.exports = { install, uninstall, status, fileFor, TARGETS };
