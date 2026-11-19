'use strict';
// Version history (every save keeps the previous copy) and daily vault backups (.zip).
const fs = require('fs');
const path = require('path');
const { zip } = require('./skills');

const KEEP_VERSIONS = 30;
const KEEP_BACKUPS = 14;
const histDir = (vault, id) => path.join(vault, '.cortex', 'history', String(id).replace(/[\\/]/g, '__'));

/** Called by the store just before it overwrites a file. */
function snapshot(vault, id, file) {
  try {
    if (!fs.existsSync(file)) return;
    const dir = histDir(vault, id);
    fs.mkdirSync(dir, { recursive: true });
    const prev = fs.readFileSync(file, 'utf8');
    const files = fs.readdirSync(dir).sort();
    if (files.length && fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8') === prev) return; // unchanged
    fs.writeFileSync(path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.md'), prev);
    for (const old of files.slice(0, Math.max(0, files.length + 1 - KEEP_VERSIONS))) fs.rmSync(path.join(dir, old), { force: true });
  } catch { /* history is best effort; never block a save */ }
}

function versions(vault, id) {
  const dir = histDir(vault, id);
  try { return fs.readdirSync(dir).sort().reverse().map((f) => ({ version: f.replace(/\.md$/, ''), size: fs.statSync(path.join(dir, f)).size })); } catch { return []; }
}

function readVersion(vault, id, version) {
  const f = path.join(histDir(vault, id), String(version).replace(/[^\w-]/g, '') + '.md');
  return fs.readFileSync(f, 'utf8');
}

function walk(dir, base, out, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    if (skip(rel)) continue;
    if (e.isDirectory()) walk(p, base, out, skip);
    else out.push({ rel, p });
  }
}

/** Zip the whole vault (minus backups/history/trash) into .cortex/backups. */
function backupNow(vault) {
  const dir = path.join(vault, '.cortex', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  walk(vault, vault, files, (rel) => /^\.cortex\/(backups|history|trash)(\/|$)/.test(rel) || /^\.obsidian\/(workspace|cache)/.test(rel) || rel.endsWith('.tmp'));
  let total = 0;
  const entries = [];
  for (const f of files) {
    const st = fs.statSync(f.p);
    if (st.size > 50 * 1024 * 1024) continue;
    total += st.size;
    if (total > 400 * 1024 * 1024) break;
    entries.push({ name: f.rel, data: fs.readFileSync(f.p) });
  }
  const name = `cortex-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
  fs.writeFileSync(path.join(dir, name), zip(entries));
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
  return { file: path.join(dir, name), files: entries.length };
}

function listBackups(vault) {
  const dir = path.join(vault, '.cortex', 'backups');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, path: path.join(dir, f) })); } catch { return []; }
}

/** Make one backup per day (call on startup and periodically). */
function daily(vault) {
  const today = new Date().toISOString().slice(0, 10);
  if (listBackups(vault).some((b) => b.name.startsWith(`cortex-${today}`))) return null;
  return backupNow(vault);
}

module.exports = { snapshot, versions, readVersion, backupNow, listBackups, daily };
