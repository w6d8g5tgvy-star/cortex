'use strict';
// Which files of a project SmartSave saves. Cheap on repeat runs: a file whose size and modified time are unchanged
// keeps its previous id without being read. Never follows symlinks/junctions, never leaves the project root, skips
// dependency/build folders and anything .gitignore excludes, and refuses credential files and files whose content
// looks like a secret (private keys, API tokens), even if you didn't list them.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache', '.turbo', 'coverage', '.nyc_output', '.gradle', '.terraform', 'obj', '.vs', '.idea', '.cortex', '.update', '.DS_Store']);
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', 'gcloud', '.password-store', 'secrets', '.secrets']);
const SECRET_NAME = [
  [/^\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i, 'environment file (.env)'],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|asc|gpg|crt|cer|der)$/i, 'key or certificate file'],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, 'SSH key'],
  [/^(\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd)$/i, 'credentials file'],
  [/^(credentials|secrets?)(\.[\w-]+)?\.(json|ya?ml|toml|ini|txt|env)$/i, 'credentials file'],
  [/^credentials$/i, 'credentials file'],
  [/service[-_]?account.*\.json$/i, 'cloud service-account key'],
  [/^accounts\.json$/i, 'account/session file'],
];
const SECRET_CONTENT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{32,}/, 'an API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\b(sk|rk)_live_[0-9A-Za-z]{20,}/, 'a Stripe key'],
];
const TEXT_SCAN_MAX = 512 * 1024;

/** Minimal .gitignore matcher (*, **, ?, leading /, trailing /, ! negation), relative to the folder holding it. */
function gitignoreRules(dirRel, text) {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false; if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    let dirOnly = false; if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    const re = line.split('/').map((seg) => (seg === '**' ? '(?:.*)' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/').replace(/\(\?:\.\*\)\//g, '(?:.*/)?');
    rules.push({ neg, dirOnly, re: new RegExp('^' + (anchored ? '' : '(?:.*/)?') + re + '(?:/.*)?$'), base: dirRel });
  }
  return rules;
}
function ignored(rules, rel, isDir) {
  let out = false;
  for (const r of rules) {
    if (r.base && !rel.startsWith(r.base + '/')) continue;
    const sub = r.base ? rel.slice(r.base.length + 1) : rel;
    if (r.dirOnly && !isDir && !r.re.test(sub.split('/').slice(0, -1).join('/') || '\0')) continue;
    if (r.re.test(sub)) out = !r.neg;
  }
  return out;
}

/**
 * Walk a project. `prev` is the previous index { path: { size, mtimeMs, id } } so unchanged files are not read.
 * Returns { files: [{ path, size, mtimeMs, mode, id?, changed }], skipped: [{ path, reason }], dirsScanned }.
 */
function scan(root, { prev = {}, exclude = [], include = [], maxFileMB = 25, maxFiles = 20000 } = {}) {
  root = path.resolve(root);
  const files = []; const skipped = []; let dirsScanned = 0;
  const extra = gitignoreRules('', [...exclude].join('\n'));
  const force = gitignoreRules('', [...include].join('\n'));
  const maxBytes = maxFileMB * 1024 * 1024;
  const walk = (abs, rel, rules) => {
    dirsScanned++;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { skipped.push({ path: rel || '.', reason: 'folder could not be read (' + e.code + ')' }); return; }
    const gi = ents.find((e) => e.name === '.gitignore' && e.isFile());
    if (gi) { try { rules = rules.concat(gitignoreRules(rel, fs.readFileSync(path.join(abs, '.gitignore'), 'utf8'))); } catch { /* unreadable */ } }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      const a = path.join(abs, e.name);
      if (e.isSymbolicLink()) { skipped.push({ path: r, reason: 'link (not followed)' }); continue; }
      if (e.isDirectory()) {
        if (SECRET_DIRS.has(e.name)) { skipped.push({ path: r + '/', reason: 'credentials folder' }); continue; }
        if (SKIP_DIRS.has(e.name) && !ignored(force, r, true)) continue;
        if ((ignored(rules, r, true) || ignored(extra, r, true)) && !ignored(force, r, true)) continue;
        walk(a, r, rules);
        continue;
      }
      if (!e.isFile()) continue;
      const secret = SECRET_NAME.find(([re]) => re.test(e.name));
      if (secret) { skipped.push({ path: r, reason: secret[1] }); continue; }
      if ((ignored(rules, r, false) || ignored(extra, r, false)) && !ignored(force, r, false)) continue;
      let st;
      try { st = fs.lstatSync(a); } catch (err) { skipped.push({ path: r, reason: 'could not be read (' + err.code + ')' }); continue; }
      if (!path.resolve(a).startsWith(root + path.sep)) { skipped.push({ path: r, reason: 'outside the project' }); continue; }
      if (st.size > maxBytes) { skipped.push({ path: r, reason: `larger than ${maxFileMB} MB` }); continue; }
      if (files.length >= maxFiles) { skipped.push({ path: r, reason: `more than ${maxFiles} files` }); continue; }
      const p = prev[r];
      const same = p && p.size === st.size && p.mtimeMs === st.mtimeMs && p.id;
      files.push({ path: r, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, ...(same ? { id: p.id } : {}), changed: !same });
    }
  };
  walk(root, '', []);
  return { files, skipped, dirsScanned };
}

/** Does this file's content look like it holds a secret? (Only small text files are checked.) */
function secretIn(buf) {
  if (buf.length > TEXT_SCAN_MAX || buf.includes(0)) return null;
  const s = buf.toString('utf8');
  const hit = SECRET_CONTENT.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
}

/** Is `rel` a safe relative path inside a project (no absolute paths, no ..)? Used when restoring. */
function safeRel(rel) {
  const r = String(rel || '');
  if (!r || r.includes('\0') || path.isAbsolute(r) || /^[a-zA-Z]:/.test(r)) return false;
  return !r.split(/[\\/]/).some((seg) => seg === '..' || seg === '');
}

module.exports = { scan, secretIn, safeRel, gitignoreRules, ignored, SKIP_DIRS };
