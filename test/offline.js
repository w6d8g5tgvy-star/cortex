'use strict';
// Offline mode (#38): with the network cut, the dashboard still opens from the saved copy; new tasks/memories and
// task edits are queued; they're sent when the connection returns; an edit to something changed elsewhere meanwhile
// is refused and reported (never silently overwritten); settings and keys are never cached.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* none */ }
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'off-')); const v = path.join(T, 'v'); const st = new Store(v);
  st.create('project', { title: 'Shop' });
  const a = st.create('task', { title: 'Write the FAQ', project: 'shop' }); const b = st.create('task', { title: 'Fix checkout', project: 'shop' });
  const port = 47100 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    // server side of the conflict rule
    const cur = await (await fetch(base + '/api/item?id=' + encodeURIComponent(b.id))).json();
    const stale = await fetch(base + '/api/items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, priority: 'high', ifUpdated: '2000-01-01T00:00:00.000Z' }) });
    assert.equal(stale.status, 409);
    assert.equal((await fetch(base + '/api/items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, priority: 'high', ifUpdated: cur.updated }) })).status, 200);
    ok('server: an edit made on an older version is refused (409) instead of overwriting newer work');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    assert.ok(!/api\/settings|api\/devices|api\/files|\/pair/.test(sw.match(/API_OK = new Set\(\[([^\]]*)\]/)[1]), 'settings, devices, files and pairing are never cached');
    ok('only read-only answers without keys are cached (settings, devices, files and pairing never)');

    if (!chromium) { console.log('  (no browser available: skipping the browser checks)'); }
    else {
      const browser = await chromium.launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
        const errs = []; page.on('pageerror', (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem('cortex.tourDone', '1'); } catch { /* private */ } });
        await page.goto(base + '/#/board'); await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
        await page.reload(); await page.waitForTimeout(1500); // the copy is saved by the worker on this load

        await ctx.setOffline(true);
        await page.reload(); await page.waitForTimeout(2500);
        const body = await page.locator('body').innerText();
        assert.ok(body.includes('Write the FAQ') && body.includes('Fix checkout'), 'board opens offline from the saved copy');
        await page.waitForSelector('#off-bar'); assert.match(await page.locator('#off-bar').innerText(), /Offline/);
        ok('offline: the dashboard opens from the copy saved on this device, with an "Offline" banner saying what needs a connection');

        const created = await page.evaluate(() => api('/api/items', { method: 'POST', body: { kind: 'task', title: 'Made on the train', project: 'shop' } }));
        assert.ok(created.queued && String(created.id).startsWith('offline-'));
        await page.evaluate((id) => api('/api/items', { method: 'PATCH', body: { id, status: 'doing' } }), created.id); // edit of an offline-created task folds in
        await page.evaluate((id) => api('/api/items', { method: 'PATCH', body: { id, status: 'done' } }), a.id);
        await page.evaluate((id) => api('/api/items', { method: 'PATCH', body: { id, title: 'Fix checkout (phone)' } }), b.id);
        await page.evaluate(() => api('/api/items', { method: 'POST', body: { kind: 'note', title: 'Idea from the train', body: 'Gift cards' } }));
        const qn = await page.evaluate(() => window.cortexOffline.queue().length); assert.equal(qn, 4);
        assert.match(await page.locator('#off-bar').innerText(), /4.*waiting/);
        const notQueued = await page.evaluate(() => api('/api/chat', { method: 'POST', body: { action: 'create' } }).then(() => 'ok', (e) => e.message));
        assert.match(notQueued, /offline/i, 'things that need a connection say so');
        ok('offline: new tasks, memories and task edits are queued on the device (4 waiting); chat says it needs a connection');

        // meanwhile someone changes "Fix checkout" on the main computer
        new Store(v).update(b.id, { title: 'Fix checkout (desktop)' }); for (let i = 0; i < 40; i++) { const x = await (await fetch(base + '/api/item?id=' + encodeURIComponent(b.id))).json(); if (x.title === 'Fix checkout (desktop)') break; await sleep(250); }
        await ctx.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => window.cortexOffline.queue().length === 0, null, { timeout: 20000 });
        await sleep(500);
        const s2 = new Store(v);
        assert.ok(s2.list('task').some((t) => t.title === 'Made on the train' && t.meta.status === 'doing'), 'offline-created task arrived (with its later edit)');
        assert.equal(s2.get(a.id).meta.status, 'done', 'offline status change applied');
        assert.equal(s2.get(b.id).title, 'Fix checkout (desktop)', 'the newer desktop change was kept');
        assert.ok(s2.list('note').some((n) => n.title === 'Idea from the train'));
        const probs = await page.evaluate(() => window.cortexOffline.problems());
        assert.equal(probs.length, 1); assert.match(probs[0].why, /changed elsewhere/);
        await page.waitForSelector('#off-bar.bad'); assert.match(await page.locator('#off-bar').innerText(), /weren't applied/);
        assert.deepEqual(errs, []);
        ok('back online: queued changes are sent in order; the one edit to something changed elsewhere is reported, not forced');
      } finally { await browser.close(); }
    }
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} offline checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
