'use strict';
// Cloud sync (2.3): keep one Cortex vault in a PRIVATE Git repository (for example on GitHub, free) so every computer
// (and cloud AI sessions) works on the same memories, tasks, projects and skills, even while the others are off.
//   - Each computer commits its changes and merges the others' every few minutes (and soon after a change).
//   - The same file changed on two computers: both versions are kept ("name (from <device>).md"), nothing is lost.
//   - Never synced: .cortex/ (settings, device keys, pairing, SmartSave keys, caches). Each computer keeps its own.
//   - Uses the git program and your own sign-in (Git Credential Manager / SSH key). Cortex never stores a password.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const IGNORE = ['# Cortex cloud sync: never synced (settings, device keys, caches)', '.cortex/', '.update/', '*.tmp', '*.cortex-tmp', '.obsidian/workspace*', '.DS_Store', 'Thumbs.db', ''].join('\n');

function git(vault, args, { timeout = 120000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: vault, timeout, maxBuffer: 50 << 20, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: process.env.GIT_ASKPASS || '' } }, (err, stdout, stderr) => {
      if (err && !allowFail) { const e = new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')); e.code = err.code; e.stdout = stdout; return reject(e); }
      resolve({ out: String(stdout || ''), err: String(stderr || ''), code: err ? err.code : 0 });
    });
  });
}
const validRemote = (r) => /^(https:\/\/[^\s"'`$;|&<>]+|git@[\w.-]+:[\w./-]+|ssh:\/\/[^\s"'`$;|&<>]+|\/[^\s"'`$;|&<>]+|[A-Za-z]:\\[^"'`$;|&<>]+)$/.test(String(r || '')) && !/[\s]/.test(String(r));
// two copies that differ only in Cortex's created/updated stamps are the same note (e.g. the welcome notes)
const sameContent = (a, b) => { const n = (t) => String(t).replace(/^(created|updated|completed):.*$/gm, '').replace(/\r\n/g, '\n').trim(); return n(a) === n(b); };
const redact = (s) => String(s || '').replace(/(https:\/\/)[^@/\s]+@/g, '$1***@');

async function available() { try { const r = await git(os.tmpdir(), ['--version'], { timeout: 10000 }); return r.out.trim(); } catch { return null; } }

/** Make the vault a repository linked to `remote` (or check an existing one). Never takes over a repo with another remote. */
async function ensure(vault, { remote, branch = 'main', device } = {}) {
  if (!validRemote(remote)) throw new Error('That repository address doesn\'t look right. Use the HTTPS address of a PRIVATE repository, e.g. https://github.com/you/cortex-vault.git');
  if (!(await available())) throw new Error('Git isn\'t installed on this computer. Install it from https://git-scm.com (Windows: "Git for Windows"), then try again.');
  fs.mkdirSync(vault, { recursive: true });
  const gi = path.join(vault, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!cur.includes('.cortex/')) fs.writeFileSync(gi, (cur ? cur.replace(/\s*$/, '\n\n') : '') + IGNORE);
  if (!fs.existsSync(path.join(vault, '.git'))) { await git(vault, ['init', '-q', '-b', branch]); }
  const r = await git(vault, ['remote', 'get-url', 'origin'], { allowFail: true });
  const have = r.out.trim();
  if (have && have !== remote) throw new Error(`This vault is already a Git repository linked to ${redact(have)}. Cortex won't change that. Use that address, or remove the link yourself first.`);
  if (!have) await git(vault, ['remote', 'add', 'origin', remote]);
  await git(vault, ['config', 'user.name', `Cortex (${device || os.hostname()})`]);
  await git(vault, ['config', 'user.email', 'cortex-sync@localhost']);
  await git(vault, ['config', 'core.quotepath', 'false']);
  // stop tracking anything under .cortex that might have been committed by hand before
  await git(vault, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.cortex'], { allowFail: true });
  return { ok: true };
}

let running = null;
/**
 * One sync round: commit local changes, merge the others', keep both sides of any conflict, push.
 * Returns { changed (files that came in), pushed, conflicts: [{ path, savedAs }] }.
 */
function sync(vault, opts = {}) { if (running) return running; running = doSync(vault, opts).finally(() => { running = null; }); return running; }
async function doSync(vault, { remote, branch = 'main', device = os.hostname() } = {}) {
  await ensure(vault, { remote, branch, device });
  const label = String(device).replace(/[^\w -]/g, '').slice(0, 30) || 'other computer';
  await git(vault, ['add', '-A']);
  const st = await git(vault, ['status', '--porcelain']);
  const hasHead = (await git(vault, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })).code === 0;
  if (st.out.trim() || !hasHead) await git(vault, ['commit', '-q', '--allow-empty', '-m', `Cortex sync from ${label} ${new Date().toISOString()}`]);
  const out = { changed: [], pushed: false, conflicts: [] };
  const f = await git(vault, ['fetch', '-q', 'origin', branch], { allowFail: true });
  const remoteHas = f.code === 0;
  if (f.code !== 0 && !/couldn't find remote ref|not found in upstream|no such ref/i.test(f.err)) throw new Error(`Couldn't reach the repository: ${redact(f.err.trim().split('\n').pop())}. Check the address and that you're signed in to GitHub on this computer.`);
  if (remoteHas) {
    const before = (await git(vault, ['rev-parse', 'HEAD'])).out.trim();
    const m = await git(vault, ['merge', '--no-edit', '-q', '--allow-unrelated-histories', `origin/${branch}`], { allowFail: true });
    if (m.code !== 0) {
      const conflicted = (await git(vault, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!conflicted.length) throw new Error(`Merge failed: ${m.err.trim().split('\n').pop()}`);
      for (const p of conflicted) {
        const ext = path.extname(p); const alt = `${p.slice(0, p.length - ext.length)} (from other computer)${ext}`;
        const theirs = await git(vault, ['show', `:3:${p}`], { allowFail: true });
        const ours = await git(vault, ['show', `:2:${p}`], { allowFail: true });
        const abs = path.join(vault, ...p.split('/'));
        if (ours.code === 0) fs.writeFileSync(abs, ours.out); else if (theirs.code === 0) fs.writeFileSync(abs, theirs.out); // deleted here, changed there: keep theirs
        if (ours.code === 0 && theirs.code === 0 && !sameContent(theirs.out, ours.out)) { let a = alt; let k = 2; while (fs.existsSync(path.join(vault, ...a.split('/')))) a = `${p.slice(0, p.length - ext.length)} (from other computer ${k++})${ext}`; fs.writeFileSync(path.join(vault, ...a.split('/')), theirs.out); out.conflicts.push({ path: p, savedAs: a }); }
      }
      await git(vault, ['add', '-A']);
      await git(vault, ['commit', '-q', '--no-edit', '-m', `Cortex sync from ${label}: kept both versions of ${conflicted.length} file(s) changed on two computers`]);
    }
    const after = (await git(vault, ['rev-parse', 'HEAD'])).out.trim();
    if (before !== after) out.changed = (await git(vault, ['diff', '--name-only', before, after])).out.split('\n').filter(Boolean);
  }
  for (let i = 0; i < 2; i++) {
    const p = await git(vault, ['push', '-q', 'origin', `HEAD:${branch}`], { allowFail: true });
    if (p.code === 0) { out.pushed = true; break; }
    if (i === 0 && /rejected|fetch first|non-fast-forward/i.test(p.err)) { const again = await doMergeOnly(vault, branch, label); out.changed.push(...again.changed); out.conflicts.push(...again.conflicts); continue; }
    throw new Error(`Couldn't upload: ${redact(p.err.trim().split('\n').pop())}. Make sure you're signed in to GitHub on this computer and can write to the repository.`);
  }
  return out;
}
async function doMergeOnly(vault, branch, label) {
  await git(vault, ['fetch', '-q', 'origin', branch]);
  const before = (await git(vault, ['rev-parse', 'HEAD'])).out.trim();
  const m = await git(vault, ['merge', '--no-edit', '-q', `origin/${branch}`], { allowFail: true });
  const conflicts = [];
  if (m.code !== 0) {
    const conflicted = (await git(vault, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
    for (const p of conflicted) { const ext = path.extname(p); const alt = `${p.slice(0, p.length - ext.length)} (from other computer)${ext}`; const t = await git(vault, ['show', `:3:${p}`], { allowFail: true }); const o = await git(vault, ['show', `:2:${p}`], { allowFail: true }); const abs = path.join(vault, ...p.split('/')); fs.writeFileSync(abs, o.code === 0 ? o.out : t.out); if (o.code === 0 && t.code === 0 && !sameContent(o.out, t.out)) { fs.writeFileSync(path.join(vault, ...alt.split('/')), t.out); conflicts.push({ path: p, savedAs: alt }); } }
    await git(vault, ['add', '-A']); await git(vault, ['commit', '-q', '--no-edit', '-m', `Cortex sync from ${label}: kept both versions`]);
  }
  const after = (await git(vault, ['rev-parse', 'HEAD'])).out.trim();
  return { changed: before === after ? [] : (await git(vault, ['diff', '--name-only', before, after])).out.split('\n').filter(Boolean), conflicts };
}

/** Background service: sync every `intervalMin` minutes and ~20 s after a local change. */
function startService({ vault, store, conf, log = () => {}, onSynced = () => {} }) {
  let timer = null; let soon = null; let last = { at: null, ok: null, error: null, changed: 0, conflicts: [] };
  const statusFile = path.join(vault, '.cortex', 'cloudsync.json');
  try { last = { ...last, ...JSON.parse(fs.readFileSync(statusFile, 'utf8')) }; } catch { /* first run */ }
  const saveStatus = () => { try { fs.mkdirSync(path.dirname(statusFile), { recursive: true }); fs.writeFileSync(statusFile, JSON.stringify(last)); } catch { /* ok */ } };
  let ignoreUntil = 0;
  const run = async (why) => {
    const c = conf().cloudSync || {}; if (!c.enabled || !c.remote) return null;
    try {
      const r = await sync(vault, { remote: c.remote, branch: c.branch || 'main', device: c.device || os.hostname() });
      last = { at: new Date().toISOString(), ok: true, error: null, changed: r.changed.length, conflicts: r.conflicts.slice(0, 20), why, pushed: r.pushed };
      if (r.changed.length) { ignoreUntil = Date.now() + 5000; store.scan(false); onSynced(r); }
      if (r.conflicts.length) log(`Cloud sync kept both versions of ${r.conflicts.length} file(s) changed on two computers.`);
      saveStatus(); return r;
    } catch (e) { last = { ...last, at: new Date().toISOString(), ok: false, error: e.message, why }; saveStatus(); log(`Cloud sync: ${e.message}`); return null; }
  };
  const schedule = () => { clearInterval(timer); const c = conf().cloudSync || {}; if (c.enabled && c.remote) timer = setInterval(() => run('timer'), Math.max(1, Number(c.intervalMin) || 5) * 60000); if (timer && timer.unref) timer.unref(); };
  store.on('change', () => { if (Date.now() < ignoreUntil) return; const c = conf().cloudSync || {}; if (!c.enabled) return; clearTimeout(soon); soon = setTimeout(() => run('change'), 20000); if (soon.unref) soon.unref(); });
  schedule();
  setTimeout(() => run('start'), 3000).unref();
  return { run, schedule, status: () => ({ ...last, running: !!running }) };
}

module.exports = { ensure, sync, startService, available, validRemote, redact, IGNORE };
