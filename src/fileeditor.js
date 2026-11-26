'use strict';
// Built-in file editor (2.3, checklist #35): light editing of a project's text files from the dashboard. It is not an
// IDE: text, Markdown and code only, up to 1 MB. Every save keeps the previous version (newest 30 per file), saves
// refuse to overwrite a file that changed on disk meanwhile, and versions can be compared and restored.
// Never opened: secrets (.env, keys, credentials, files that contain tokens), .git, node_modules and build folders.
// The project folder must be one of the folders allowed in Settings → Agent control.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SKIP_DIRS, SECRET_DIRS, SECRET_NAME, secretIn } = require('./smartsave/scan');

const MAX = 1024 * 1024;
const KEEP = 30;
const TEXT = /\.(md|markdown|txt|json|jsonc|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|lua|luau|html|htm|css|scss|less|yml|yaml|toml|ini|cfg|conf|xml|svg|log|sh|bash|zsh|ps1|bat|cmd|java|kt|cs|go|rs|rb|php|swift|c|h|cpp|hpp|cc|sql|graphql|vue|svelte|astro|r|dart|gradle|properties|gitignore|editorconfig|env\.example|rbxlx|rbxmx)$/i;
const BARE_TEXT = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'README', 'Procfile', '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc']);

function err(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/** Resolve a path inside the project folder, refusing anything outside it or anything secret. */
function resolve(root, rel, { forWrite = false } = {}) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r || r.split('/').some((s) => s === '..' || s === '')) throw err('That path isn\'t inside the project');
  const parts = r.split('/');
  for (const p of parts.slice(0, -1)) { if (SKIP_DIRS.has(p)) throw err(`Files in ${p}/ can't be opened here`); if (SECRET_DIRS.has(p)) throw err('Credential folders are never opened'); }
  const name = parts[parts.length - 1];
  const secret = SECRET_NAME.find(([re]) => re.test(name)); if (secret) throw err(`This looks like a ${secret[1]}: secrets are never opened in Cortex`, 403);
  if (!TEXT.test(name) && !BARE_TEXT.has(name)) throw err('Only text, Markdown and code files can be edited here');
  const abs = path.join(root, ...parts);
  const realRoot = fs.realpathSync.native(root);
  let check;
  if (fs.existsSync(abs)) check = fs.realpathSync.native(abs);
  else { let up = path.dirname(abs); const rest = [name]; while (!fs.existsSync(up)) { rest.unshift(path.basename(up)); up = path.dirname(up); } check = path.join(fs.realpathSync.native(up), ...rest); } // new file: check the nearest existing folder
  const relCheck = path.relative(realRoot, check);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw err('That path isn\'t inside the project');
  if (forWrite && fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw err('Links aren\'t edited here');
  return { abs, rel: r };
}

/** The project's editable files (a tree as a flat list), skipping build folders, secrets and big files. */
function tree(root, { max = 3000 } = {}) {
  const out = []; let truncated = false;
  const walk = (dir, rel) => {
    if (out.length >= max) { truncated = true; return; }
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of ents) {
      if (out.length >= max) { truncated = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) || SECRET_DIRS.has(e.name)) continue; walk(path.join(dir, e.name), r); continue; }
      if (SECRET_NAME.some(([re]) => re.test(e.name))) continue;
      if (!TEXT.test(e.name) && !BARE_TEXT.has(e.name)) continue;
      let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch { continue; }
      if (size > MAX) continue;
      out.push({ path: r, size });
    }
  };
  walk(root, '');
  return { files: out, truncated };
}

function read(root, rel) {
  const { abs, rel: r } = resolve(root, rel);
  if (!fs.existsSync(abs)) throw err('File not found', 404);
  const st = fs.statSync(abs); if (st.size > MAX) throw err('Files over 1 MB aren\'t opened here');
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw err('This isn\'t a text file');
  const s = secretIn(buf); if (s) throw err(`This file contains ${s}: it isn't opened in Cortex. Move the secret out of the file first.`, 403);
  return { path: r, text: buf.toString('utf8'), mtimeMs: Math.floor(st.mtimeMs), size: st.size };
}

const histDir = (vault, project, rel) => path.join(vault, '.cortex', 'file-history', String(project).replace(/[^\w-]/g, ''), crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16));
function snapshot(vault, project, rel, text, why) {
  const d = histDir(vault, project, rel); fs.mkdirSync(d, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  fs.writeFileSync(path.join(d, id + '.txt'), text); fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ id, path: rel, why, at: new Date().toISOString(), size: Buffer.byteLength(text) }));
  const all = fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) { fs.rmSync(path.join(d, f), { force: true }); fs.rmSync(path.join(d, f.replace(/\.json$/, '.txt')), { force: true }); }
  return id;
}
function history(vault, project, rel) {
  const d = histDir(vault, project, rel); let fsl = []; try { fsl = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { return []; }
  return fsl.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.id < b.id ? 1 : -1));
}
function version(vault, project, rel, id) {
  const f = path.join(histDir(vault, project, rel), String(id).replace(/[^\w-]/g, '') + '.txt');
  if (!fs.existsSync(f)) throw err('Version not found', 404);
  return fs.readFileSync(f, 'utf8');
}

/** Save. `baseMtimeMs` = when the editor loaded it; refuses (409) if the file changed on disk since. */
function write(vault, project, root, rel, text, { baseMtimeMs, create = false, by = 'you' } = {}) {
  text = String(text == null ? '' : text);
  if (Buffer.byteLength(text) > MAX) throw err('Files over 1 MB aren\'t saved here');
  const s = secretIn(Buffer.from(text)); if (s) throw err(`What you typed contains ${s}. Secrets aren't saved through Cortex: put it in a .env file yourself.`, 403);
  const { abs, rel: r } = resolve(root, rel, { forWrite: true });
  const exists = fs.existsSync(abs);
  if (!exists && !create) throw err('File not found', 404);
  if (exists && create) throw err('A file with that name already exists', 409);
  if (exists) {
    const st = fs.statSync(abs);
    if (baseMtimeMs != null && Math.abs(Math.floor(st.mtimeMs) - Number(baseMtimeMs)) > 2) { const e = err('This file changed on disk since you opened it (maybe an agent edited it). Compare and reload before saving.', 409); e.current = read(root, r); throw e; }
    const old = fs.readFileSync(abs, 'utf8');
    if (old === text) return { path: r, mtimeMs: Math.floor(st.mtimeMs), unchanged: true };
    snapshot(vault, project, r, old, `before save by ${by}`);
  } else fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.cortex-tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, abs);
  return { path: r, mtimeMs: Math.floor(fs.statSync(abs).mtimeMs), created: !exists };
}

/** Search the project's text files. */
function search(root, q, { max = 200 } = {}) {
  q = String(q || '').trim(); if (q.length < 2) return { results: [], truncated: false };
  const low = q.toLowerCase(); const results = []; let truncated = false;
  for (const f of tree(root, { max: 5000 }).files) {
    if (results.length >= max) { truncated = true; break; }
    let text; try { const buf = fs.readFileSync(path.join(root, ...f.path.split('/'))); if (buf.includes(0) || secretIn(buf)) continue; text = buf.toString('utf8'); } catch { continue; }
    const pathHit = f.path.toLowerCase().includes(low);
    const lines = text.split(/\r?\n/); const hits = [];
    for (let i = 0; i < lines.length && hits.length < 5; i++) if (lines[i].toLowerCase().includes(low)) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
    if (pathHit || hits.length) results.push({ path: f.path, hits });
  }
  return { results, truncated };
}

/** Line diff (LCS) for comparing versions: [{ op: ' ' | '+' | '-', text }]. Large inputs fall back to a summary. */
function diff(a, b) {
  const A = String(a).split(/\r?\n/); const B = String(b).split(/\r?\n/);
  if (A.length * B.length > 4e6) return { tooBig: true, lines: [], added: Math.max(0, B.length - A.length), removed: Math.max(0, A.length - B.length) };
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e); const b2 = B.slice(s, B.length - e);
  const n = a2.length; const m = b2.length; const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; for (let k = Math.max(0, s - 3); k < s; k++) out.push({ op: ' ', text: A[k], n: k + 1 });
  let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { out.push({ op: ' ', text: a2[i] }); i++; j++; }
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { out.push({ op: '-', text: a2[i] }); i++; }
    else { out.push({ op: '+', text: b2[j] }); j++; }
  }
  for (let k = A.length - e; k < Math.min(A.length, A.length - e + 3); k++) out.push({ op: ' ', text: A[k] });
  return { lines: out, added: out.filter((x) => x.op === '+').length, removed: out.filter((x) => x.op === '-').length };
}

module.exports = { tree, read, write, search, history, version, diff, resolve, MAX, KEEP };
