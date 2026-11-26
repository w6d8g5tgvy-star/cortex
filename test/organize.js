'use strict';
// Automatic project organization (#33): suggestions for tags, filing, related links, duplicates, outdated memories,
// inbox files and task priorities; nothing changes until approved; dismissals stick; only safe kinds may auto-apply;
// nothing is deleted; changes go through normal edits (undo works).
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const org = require('../src/organize');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const age = (st, id, iso) => { const f = st.fileOf(id); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/updated: "[^"]+"/, `updated: "${iso}"`)); };

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'org-')); const v = path.join(T, 'v'); let st = new Store(v);
  st.create('project', { title: 'Skyblock Macro' }); st.create('project', { title: 'Shop' });
  st.create('note', { title: 'Stripe keys rotation', body: 'How we rotate stripe webhooks.', tags: ['stripe'], project: 'shop' });
  st.create('note', { title: 'Stripe refunds', body: 'Refund flow with stripe.', tags: ['stripe'], project: 'shop' });
  const t1 = st.create('note', { title: 'Payment provider notes', body: 'We picked stripe because of payouts and stripe checkout.', project: 'shop' });
  const unfiled = st.create('note', { title: 'Farming route ideas', body: 'For Skyblock Macro: use the pumpkin farm route at night.' });
  const d1 = st.create('note', { title: 'Deploy checklist', body: 'Run tests, bump version, push main, verify release json.', project: 'shop' });
  const d2 = st.create('note', { title: 'Deploy checklist', body: 'Run tests, bump the version, push main and verify release json.', project: 'shop' });
  const old = st.create('note', { title: 'Checkout page design', body: 'Old layout with two columns and a sidebar.', project: 'shop' });
  const newer = st.create('note', { title: 'Checkout page design v2', body: 'Single column, express pay buttons at top.', project: 'shop' });
  const r1 = st.create('note', { title: 'Mob grinder layout', body: 'Spawner grinder layout with water flow and hoppers for drops', project: 'skyblock-macro' });
  const r2 = st.create('note', { title: 'Grinder hopper timing', body: 'Hopper timing for the spawner grinder layout, water flow resets', project: 'skyblock-macro' });
  const overdue = st.create('task', { title: 'Renew domain', project: 'shop', due: '2020-01-01', priority: 'medium' });
  const base = st.create('task', { title: 'Set up database', project: 'shop', priority: 'low' });
  st.create('task', { title: 'Build API', project: 'shop', depends_on: base.id });
  const idle = st.create('task', { title: 'Write blog post', project: 'shop', priority: 'medium' });
  age(st, old.id, '2025-01-01T00:00:00.000Z'); age(st, idle.id, '2025-06-01T00:00:00.000Z');
  fs.mkdirSync(path.join(v, 'attachments', 'inbox'), { recursive: true }); fs.writeFileSync(path.join(v, 'attachments', 'inbox', 'skyblock-macro-config.txt'), 'macro settings');
  st.update(r1.id, { body: st.get(r1.id).body }); // a normal edit (to check undo later)
  st = new Store(v);

  const before = fs.readdirSync(v, { recursive: true }).length;
  const s = org.suggest(st);
  const find = (kind, pred) => s.find((x) => x.kind === kind && pred(x));
  assert.ok(find('tag', (x) => x.ref === t1.id && x.tags.includes('stripe')), 'tags only from your own vocabulary');
  assert.ok(find('project', (x) => x.ref === unfiled.id && x.project === 'skyblock-macro'), 'unfiled memory → its project');
  assert.ok(find('duplicate', (x) => [x.ref, x.other].sort().join() === [d1.id, d2.id].sort().join()));
  assert.ok(find('outdated', (x) => x.ref === old.id && x.other === newer.id));
  assert.ok(find('related', (x) => [x.ref, x.other].sort().join() === [r1.id, r2.id].sort().join()));
  assert.ok(find('file', (x) => x.file === 'skyblock-macro-config.txt' && x.project === 'skyblock-macro'));
  assert.ok(find('priority', (x) => x.ref === overdue.id && x.priority === 'high'), 'overdue → high');
  assert.ok(find('priority', (x) => x.ref === base.id && x.priority === 'high' && /waiting for it/.test(x.why)), 'blocking → high');
  assert.ok(find('priority', (x) => x.ref === idle.id && x.priority === 'low'), 'idle for months → low');
  assert.equal(fs.readdirSync(v, { recursive: true }).length, before, 'suggesting changes nothing');
  ok('suggestions: tags from your own vocabulary, filing, duplicates, outdated, related links, inbox files, task priorities; nothing changed yet');

  const notesBefore = st.list('note').length;
  for (const kind of ['tag', 'project', 'duplicate', 'outdated', 'related', 'file', 'priority']) { const x = s.find((y) => y.kind === kind); org.apply(st, x.id, { by: 'test' }); }
  st = new Store(v);
  assert.ok(st.get(t1.id).tags.includes('stripe'));
  assert.equal(st.list('note').find((n) => n.title === 'Farming route ideas').meta.project, 'skyblock-macro');
  assert.ok(st.list('note').filter((n) => n.title === 'Deploy checklist').every((n) => n.tags.includes('possible-duplicate') && /Possible duplicate of \[\[Deploy checklist\]\]/.test(n.body)), 'both duplicates kept and marked');
  assert.ok(st.get(old.id).body.startsWith('> ⚠ Possibly outdated: see [[Checkout page design v2]]') && st.get(old.id).body.includes('Old layout'), 'outdated memory flagged, text kept');
  assert.ok(st.get(r1.id).body.includes('Related: [[Grinder hopper timing]]') && st.get(r2.id).body.includes('Related: [[Mob grinder layout]]'));
  assert.ok(fs.existsSync(path.join(v, 'attachments', 'skyblock-macro', 'skyblock-macro-config.txt')) && !fs.existsSync(path.join(v, 'attachments', 'inbox', 'skyblock-macro-config.txt')));
  assert.equal(st.get(overdue.id).meta.priority, 'high');
  assert.equal(st.list('note').length, notesBefore, 'no memory deleted');
  assert.ok(require('../src/undo').list(v, 50).some((u) => /Edited note "Payment provider notes"/.test(u.summary)), 'changes are normal edits: Undo has them');
  assert.throws(() => org.apply(st, 'made-up-id'), /no longer valid/, 'only what Cortex proposed can be applied');
  const again = org.suggest(st); assert.ok(!again.some((x) => x.ref === t1.id && x.kind === 'tag'), 'applied suggestions don\'t come back');
  const dis = again.find((x) => x.kind === 'priority'); org.dismiss(v, dis.id); assert.ok(!org.suggest(st).some((x) => x.id === dis.id), 'dismissed suggestions don\'t come back');
  ok('applying: each change is a normal, undoable edit; duplicates and outdated notes are marked, never deleted; files moved; dismissals stick');

  // auto-run: only safe kinds
  st.create('note', { title: 'Stripe tax notes', body: 'Tax handling in stripe for EU.', project: 'shop' }); st = new Store(v);
  const autoDone = org.autoRun(st, ['tag', 'priority', 'duplicate']);
  assert.ok(autoDone.length >= 1 && autoDone.every((x) => x.kind === 'tag'), 'priority/duplicate are never auto-applied even if asked');
  ok('automatic tidy-up: only tags, related links, filing and inbox files can run on their own');

  // server + page
  const port = 46100 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v, '--port', String(port)], { stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(baseUrl + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    const g = await (await fetch(baseUrl + '/api/organize')).json(); assert.ok(Array.isArray(g.suggestions) && g.safeAuto.includes('tag'));
    const au = await (await fetch(baseUrl + '/api/organize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'auto', auto: ['tag', 'priority'] }) })).json();
    assert.deepEqual(au.auto, ['tag'], 'server drops kinds that may not auto-run');
    let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* none */ }
    if (!chromium) console.log('  (no browser available: skipping the page check)');
    else {
      new Store(v).create('task', { title: 'Pay invoice', project: 'shop', due: '2021-01-01' });
      const browser = await chromium.launch();
      try {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem('cortex.tourDone', '1'); } catch { /* private */ } });
        await page.goto(baseUrl + '/#/projects'); await page.waitForSelector('#og-panel [data-og-a]');
        const item = page.locator('.og-item', { hasText: 'Pay invoice' }); await item.locator('[data-og-a]').click();
        await page.waitForFunction(() => document.querySelector('#og-panel [data-og-a]') && ![...document.querySelectorAll('.og-item')].some((x) => x.innerText.includes('Pay invoice')));
        assert.equal(new Store(v).list('task').find((t) => t.title === 'Pay invoice').meta.priority, 'high');
        assert.deepEqual(errs, []);
      } finally { await browser.close(); }
      ok('page: the Tidy up panel lists suggestions and Apply changes the item');
    }
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} organization checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
