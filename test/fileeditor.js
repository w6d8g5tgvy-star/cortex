'use strict';
// Built-in file editor (#35): stays inside the project, never opens secrets, keeps versions, refuses to overwrite
// changes made on disk, compares and restores versions, phones read-only unless allowed, and the editor page works.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const fe = require('../src/fileeditor');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-')); const proj = path.join(T, 'proj'); const v = path.join(T, 'v');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true }); fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true }); fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# Shop\nSells things.');
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'const a = 1;\nconst b = 2;\nmodule.exports = a + b;\n');
  fs.writeFileSync(path.join(proj, '.env'), 'STRIPE=sk_live_' + 'x'.repeat(24));
  fs.writeFileSync(path.join(proj, 'config.js'), 'const key = "ghp_' + 'a'.repeat(36) + '";');
  fs.writeFileSync(path.join(proj, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 0]));
  fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'i.js'), 'x');
  fs.writeFileSync(path.join(T, 'outside.md'), 'outside');
  try { fs.symlinkSync(path.join(T, 'outside.md'), path.join(proj, 'link.md')); } catch { /* no symlinks on this system */ }

  // ---------- unit ----------
  const files = fe.tree(proj).files.map((f) => f.path);
  assert.deepEqual(files.sort(), ['README.md', 'config.js', 'src/app.js'].sort(), 'tree: text files only; no .env, node_modules, .git, binaries or links');
  assert.throws(() => fe.read(proj, '../outside.md'), /isn't inside the project/);
  assert.throws(() => fe.read(proj, '.env'), /environment file.*never opened/);
  assert.throws(() => fe.read(proj, 'config.js'), /contains a GitHub token/);
  assert.throws(() => fe.read(proj, 'node_modules/x/i.js'), /can't be opened here/);
  assert.throws(() => fe.read(proj, '.git/config'), /can't be opened here|Only text/);
  assert.throws(() => fe.read(proj, 'logo.png'), /Only text/);
  if (fs.existsSync(path.join(proj, 'link.md'))) assert.throws(() => fe.read(proj, 'link.md'), /isn't inside the project/, 'a link pointing outside is refused');
  ok('safety: stays inside the project, never opens .env/keys/files holding tokens, skips build folders, binaries and links outside');

  const r0 = fe.read(proj, 'src/app.js');
  const w1 = fe.write(v, 'shop', proj, 'src/app.js', r0.text.replace('2', '3'), { baseMtimeMs: r0.mtimeMs });
  assert.ok(fs.readFileSync(path.join(proj, 'src', 'app.js'), 'utf8').includes('b = 3'));
  await sleep(20); fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'agent rewrote it\n');
  assert.throws(() => fe.write(v, 'shop', proj, 'src/app.js', 'mine', { baseMtimeMs: w1.mtimeMs }), (e) => e.status === 409 && e.current.text === 'agent rewrote it\n', 'a file changed on disk is never silently overwritten');
  assert.throws(() => fe.write(v, 'shop', proj, 'src/app.js', 'token ghp_' + 'b'.repeat(36), { baseMtimeMs: fe.read(proj, 'src/app.js').mtimeMs }), /Secrets aren't saved/);
  assert.throws(() => fe.write(v, 'shop', proj, '.env', 'X=1', { create: true }), /never opened/);
  const hist = fe.history(v, 'shop', 'src/app.js'); assert.equal(hist.length, 1); assert.ok(fe.version(v, 'shop', 'src/app.js', hist[0].id).includes('b = 2'));
  const d = fe.diff('a\nb\nc\nd', 'a\nB\nc\nd\ne'); assert.deepEqual(d.lines.filter((l) => l.op !== ' ').map((l) => l.op + l.text), ['-b', '+B', '+e']);
  for (let i = 0; i < fe.KEEP + 5; i++) { const c = fe.read(proj, 'README.md'); fe.write(v, 'shop', proj, 'README.md', c.text + i, { baseMtimeMs: c.mtimeMs }); }
  assert.equal(fe.history(v, 'shop', 'README.md').length, fe.KEEP, 'only the newest versions are kept');
  const created = fe.write(v, 'shop', proj, 'notes/plan.md', '# Plan', { create: true }); assert.ok(created.created && fs.existsSync(path.join(proj, 'notes', 'plan.md')));
  const s = fe.search(proj, 'module.exports'); assert.deepEqual(s.results.map((x) => x.path), []); // app.js was rewritten by the "agent"
  assert.ok(fe.search(proj, 'agent rewrote').results[0].hits[0].line === 1);
  assert.ok(!fe.search(proj, 'ghp_').results.length, 'search never shows files that hold secrets');
  ok('editing: versions before every save (newest 30), conflicts detected, secrets refused, diff, new files, search');

  // ---------- server ----------
  const st = new Store(v); st.create('project', { title: 'Shop', folder: proj }); st.create('project', { title: 'Other', folder: T });
  fs.mkdirSync(path.join(v, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(v, '.cortex', 'settings.json'), JSON.stringify({ remote: { enabled: true, token: 'tok-1234567890' }, agents: { enabled: true, folders: [proj] } }));
  const port = 45000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const get = async (b, q, h = {}) => { const r = await fetch(`${b}/api/files?${new URLSearchParams(q)}`, { headers: h }); return { status: r.status, j: await r.json() }; };
  const post = async (b, body, h = {}) => { const r = await fetch(b + '/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    assert.equal((await get(base, { project: 'other' })).status, 403, 'only allowed folders');
    const t = await get(base, { project: 'shop' }); assert.ok(t.j.canEdit && t.j.files.some((f) => f.path === 'README.md'));
    const rd = await get(base, { project: 'shop', op: 'read', path: 'README.md' });
    const sv = await post(base, { project: 'shop', action: 'save', path: 'README.md', text: '# Shop v2', baseMtimeMs: rd.j.mtimeMs }); assert.equal(sv.status, 200);
    assert.equal((await post(base, { project: 'shop', action: 'save', path: 'README.md', text: 'stale', baseMtimeMs: rd.j.mtimeMs })).status, 409);
    const hv = await get(base, { project: 'shop', op: 'history', path: 'README.md' }); const first = hv.j.versions[0];
    const df = await get(base, { project: 'shop', op: 'diff', path: 'README.md', id: first.id }); assert.ok(df.j.lines.some((l) => l.op === '+' && l.text === '# Shop v2'));
    const rs = await post(base, { project: 'shop', action: 'restore', path: 'README.md', id: first.id }); assert.equal(rs.status, 200); assert.notEqual(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), '# Shop v2');
    assert.equal((await get(base, { project: 'shop', op: 'read', path: '.env' })).status, 403);
    ok('server: allowed folders only, save/conflict/history/compare/restore, secrets refused');
    if (lanIp) {
      const remote = `http://${lanIp}:${port}`; const H = { Cookie: 'cortex_token=tok-1234567890' };
      const rr = await get(remote, { project: 'shop', op: 'read', path: 'README.md' }, H); assert.equal(rr.status, 200); assert.equal(rr.j.canEdit, false);
      assert.equal((await post(remote, { project: 'shop', action: 'save', path: 'README.md', text: 'from phone', baseMtimeMs: rr.j.mtimeMs }, H)).status, 403, 'phones are read-only by default');
      assert.equal((await fetch(remote + '/api/files/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: '{"remoteEdit":true}' })).status, 403, 'only the main computer can allow phone editing');
      await fetch(base + '/api/files/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"remoteEdit":true}' });
      assert.equal((await post(remote, { project: 'shop', action: 'save', path: 'README.md', text: 'from phone', baseMtimeMs: rr.j.mtimeMs }, H)).status, 200);
      ok('phones: read-only until the main computer allows editing');
    }

    let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* none */ }
    if (!chromium) console.log('  (no browser available: skipping the page check)');
    else {
      const browser = await chromium.launch();
      try {
        for (const [name, vp] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
          const page = await (await browser.newContext({ viewport: vp })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
          await page.addInitScript(() => { try { localStorage.setItem('cortex.tourDone', '1'); } catch { /* private */ } });
          await page.goto(base + '/#/projects/shop'); await page.waitForSelector('#fe-open'); await page.click('#fe-open');
          await page.waitForSelector('.fe-f'); await page.click('.fe-f[data-f="notes/plan.md"]'); await page.waitForSelector('.fe-ta');
          await page.fill('.fe-ta', `# Plan from ${name}\n- ship it`);
          await page.waitForFunction(() => /Saved/.test(document.querySelector('#fe-st').textContent), null, { timeout: 6000 });
          assert.equal(fs.readFileSync(path.join(proj, 'notes', 'plan.md'), 'utf8'), `# Plan from ${name}\n- ship it`, `${name}: autosaved to disk`);
          await page.click('[data-m="preview"]'); assert.ok((await page.locator('.fe-prev').innerText()).includes(`Plan from ${name}`));
          await page.click('[data-m="history"]'); await page.waitForSelector('[data-cmp]'); await page.click('[data-cmp] >> nth=0'); await page.waitForSelector('.fe-diff .a');
          await page.fill('#fe-filter', 'agent rewrote'); await page.press('#fe-filter', 'Enter'); await page.waitForSelector('.fe-hit');
          if (name === 'desktop') await page.screenshot({ path: path.join(T, 'fe.png') });
          await page.click('#fe-close'); assert.equal(await page.locator('#fe-ov').count(), 0);
          assert.deepEqual(errs, [], `${name}: no page errors`);
        }
      } finally { await browser.close(); }
      ok('page: open from the project, edit with autosave, preview, compare history, search inside files (desktop + phone)');
    }
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} file editor checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
