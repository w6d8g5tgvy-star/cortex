'use strict';
// Visual workflow builder (#34): validation, templates, free test runs, real runs, approvals, limits, triggers, page.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const wf = require('../src/workflows');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')); const v = path.join(T, 'v'); const st = new Store(v);
  st.create('project', { title: 'Shop' });
  st.create('note', { title: 'Stripe decision', body: 'We use Stripe for payments.', project: 'shop' });

  // ---------- validation ----------
  assert.ok(!wf.validate({ name: '', nodes: [] }).ok);
  const bad = wf.validate({ name: 'x', nodes: [{ id: 'a', type: 'trigger', next: ['zz'] }, { id: 'b', type: 'agent', config: {} }, { id: 'c', type: 'tool', config: { name: 'rm_rf' } }] });
  assert.ok(bad.errors.some((e) => /missing step "zz"/.test(e)) && bad.errors.some((e) => /tell the agent/.test(e)) && bad.errors.some((e) => /choose a tool/.test(e)));
  assert.ok(bad.warnings.some((w) => /never be reached/.test(w)));
  assert.ok(wf.validate({ name: 'x', nodes: [{ id: 'a', type: 'trigger', config: { on: 'schedule', everyMinutes: 1 } }] }).errors.some((e) => /5 minutes/.test(e)), 'schedules can\'t hammer');
  const loop = wf.validate({ name: 'loop', nodes: [{ id: 's', type: 'trigger', next: ['n'] }, { id: 'n', type: 'notify', config: { title: 'hi' }, next: ['n'] }] });
  assert.ok(loop.ok && loop.warnings.some((w) => /loops/.test(w)));
  for (const t of wf.TEMPLATES) assert.ok(wf.validate(t).ok, `template "${t.name}" is valid`);
  ok('validation: missing links, empty agents, tools outside the allow-list, unreachable steps, loops, fast schedules; all templates valid');

  // ---------- test run: nothing changes ----------
  const tasksBefore = st.list('task').length; const notesBefore = st.list('note').length;
  const tpl = wf.TEMPLATES.find((t) => t.template === 'review-before-merge');
  let launched = 0; const notes = [];
  const deps = { store: st, notify: (vv, n) => notes.push(n), launchAgent: async (o) => { launched++; return { status: 'done', result: `Changed logo.svg for: ${o.prompt.split('\n')[0]}`, runId: 'run-fake' }; } };
  const tr = await wf.start(v, tpl, { trigger: { title: 'Fix the logo' }, test: true }, deps);
  assert.equal(tr.status, 'done'); assert.equal(launched, 0, 'test runs never start agents');
  assert.ok(tr.steps.find((s) => s.node === 'work').output.includes('[test] An agent would be asked: Work on this: Fix the logo'));
  assert.equal(st.list('task').length, tasksBefore); assert.equal(st.list('note').length, notesBefore); assert.equal(notes.length, 0);
  const rej = await wf.start(v, tpl, { trigger: { title: 'Fix the logo' }, test: true, testApprove: false }, deps);
  assert.deepEqual(rej.steps.map((s) => s.node), ['start', 'work', 'ok', 'retry'], 'test can follow the "rejected" path too');
  ok('test runs: agents, tasks, memories and notifications are simulated; both approval paths can be tried');

  // ---------- real run with an approval ----------
  const saved = wf.save(v, { ...tpl, name: 'Fix with approval' }).workflow;
  let run = await wf.start(v, saved.id, { trigger: { title: 'Fix the logo', project: 'shop' } }, deps);
  assert.equal(run.status, 'waiting'); assert.equal(launched, 1); assert.ok(notes.some((n) => n.kind === 'approval' && /needs your approval/.test(n.title)));
  assert.ok(wf.getRun(v, run.id).waitingMessage.includes('Changed logo.svg'));
  run = await wf.decide(v, run.id, true, deps, { by: 'phone' });
  assert.equal(run.status, 'done'); assert.ok(notes.some((n) => n.title === 'Done: Fix the logo'));
  assert.ok(run.steps.find((s) => s.node === 'ok').note.startsWith('Approved by phone'));
  await assert.rejects(() => wf.decide(v, run.id, true, deps), /not waiting/);
  let run2 = await wf.start(v, saved.id, { trigger: { title: 'Fix the footer', project: 'shop' } }, deps);
  run2 = await wf.decide(v, run2.id, false, deps);
  assert.ok(st.list('task').some((t) => t.title === 'Redo: Fix the footer' && t.meta.priority === 'high'), 'rejection path creates a follow-up task');
  ok('real runs: agent step runs, approval pauses and notifies, approve/reject continue down the right path');

  // ---------- conditions, tools, outputs ----------
  const research = wf.TEMPLATES.find((t) => t.template === 'research-to-note');
  const known = await wf.start(v, research, { trigger: { question: 'Stripe payments' } }, deps);
  assert.deepEqual(known.steps.map((s) => s.node), ['start', 'known', 'has', 'end'], 'already known → no agent');
  assert.ok(known.steps[1].output.includes('Stripe decision'));
  const unknown = await wf.start(v, research, { trigger: { question: 'quantum widgets' } }, deps);
  assert.deepEqual(unknown.steps.map((s) => s.node), ['start', 'known', 'has', 'research', 'save']);
  assert.ok(st.list('note').some((n) => n.title === 'Research: quantum widgets'));
  ok('conditions branch, memory search feeds the next step, output saves a memory');

  // ---------- limits ----------
  const looping = { name: 'loop', limits: { maxSteps: 7 }, nodes: [{ id: 's', type: 'trigger', next: ['a'] }, { id: 'a', type: 'condition', config: { op: 'not_empty', left: 'x' }, next: ['a'] }] };
  const lr = await wf.start(v, looping, {}, deps); assert.equal(lr.status, 'stopped'); assert.match(lr.error, /limit of 7 steps/); assert.equal(lr.steps.length, 7);
  const greedy = { name: 'agents', limits: { maxAgentRuns: 1 }, nodes: [{ id: 's', type: 'trigger', next: ['a1'] }, { id: 'a1', type: 'agent', config: { prompt: 'one' }, next: ['a2'] }, { id: 'a2', type: 'agent', config: { prompt: 'two' } }] };
  const gr = await wf.start(v, greedy, {}, deps); assert.equal(gr.status, 'stopped'); assert.match(gr.error, /Agent run limit/);
  const failing = { name: 'fail', nodes: [{ id: 's', type: 'trigger', next: ['a'] }, { id: 'a', type: 'agent', config: { prompt: 'x' }, next: ['n'], else: ['f'] }, { id: 'n', type: 'notify', config: { title: 'worked' } }, { id: 'f', type: 'task', config: { title: 'Agent failed: look' } }] };
  const fr = await wf.start(v, failing, {}, { ...deps, launchAgent: async () => ({ status: 'error', result: 'usage limit' }) });
  assert.equal(fr.status, 'done'); assert.ok(st.list('task').some((t) => t.title === 'Agent failed: look'), 'agent failure can take its own path');
  const off = wf.save(v, { ...looping, name: 'off', enabled: false }).workflow;
  await assert.rejects(() => wf.start(v, off.id, {}, deps), /turned off/);
  ok('limits: loops stop at the step limit, agent runs are capped, failed agents can branch, turned-off workflows don\'t run');

  // ---------- triggers ----------
  wf.save(v, { name: 'On done', nodes: [{ id: 's', type: 'trigger', config: { on: 'task.done', project: 'shop' }, next: ['n'] }, { id: 'n', type: 'notify', config: { title: 'Finished: {{trigger.title}}' } }] });
  assert.equal(wf.matching(v, 'task.done', { project: 'shop' }).length, 1); assert.equal(wf.matching(v, 'task.done', { project: 'other' }).length, 0);
  wf.save(v, { name: 'Hourly', nodes: [{ id: 's', type: 'trigger', config: { on: 'schedule', everyMinutes: 60 } }] });
  const t0 = Date.now(); assert.equal(wf.due(v, {}, t0).length, 1); assert.equal(wf.due(v, { [wf.list(v).find((w) => w.name === 'Hourly').id]: t0 - 30 * 60000 }, t0).length, 0);
  ok('triggers: task events match by project; schedules are due only after their interval');

  // ---------- server + page ----------
  const fakeBin = path.join(T, 'fake-claude');
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d).on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'fake-model'}));setTimeout(()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:'Did it',num_turns:1,total_cost_usd:0}));},200)});\n`, { mode: 0o755 });
  const work = path.join(T, 'work'); fs.mkdirSync(work);
  const v2 = path.join(T, 'v2'); const st2 = new Store(v2); st2.create('project', { title: 'Shop' });
  fs.mkdirSync(path.join(v2, '.cortex'), { recursive: true }); fs.writeFileSync(path.join(v2, '.cortex', 'settings.json'), JSON.stringify({ agents: { enabled: true, folders: [work] } }));
  const port = 43000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v2, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, CORTEX_CLAUDE_BIN: fakeBin } });
  const base = `http://127.0.0.1:${port}`;
  const post = async (b) => { const r = await fetch(base + '/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    const g = await (await fetch(base + '/api/workflows')).json(); assert.ok(g.templates.length >= 4 && g.types.agent && g.tools.includes('memory_search'));
    assert.equal((await post({ workflow: { name: '', nodes: [] } })).status, 400);
    const s1 = await post({ workflow: { name: 'Agent then notify', nodes: [{ id: 's', type: 'trigger', next: ['a'] }, { id: 'a', type: 'agent', config: { prompt: 'Say hi about {{trigger.title}}', project: 'shop' }, next: ['n'] }, { id: 'n', type: 'notify', config: { title: 'Agent said: {{last.output}}' } }] } });
    assert.equal(s1.status, 200);
    const real = await post({ action: 'run', id: s1.j.workflow.id, trigger: { title: 'the shop' } });
    assert.equal(real.j.run.status, 'done', JSON.stringify(real.j)); assert.equal(real.j.run.steps[1].output, 'Did it'); assert.ok(real.j.run.steps[1].runId);
    const nl = await (await fetch(base + '/api/notifications')).json(); assert.ok(JSON.stringify(nl).includes('Agent said: Did it'));
    ok('server: save with validation, run with a real (fake-CLI) agent through the normal launcher, notification sent');

    await post({ workflow: { name: 'Tell me when done', nodes: [{ id: 's', type: 'trigger', config: { on: 'task.done' }, next: ['n'] }, { id: 'n', type: 'notify', config: { title: 'Finished: {{trigger.title}}' } }] } });
    await post({ workflow: { name: 'Approve', nodes: [{ id: 's', type: 'trigger', next: ['ap'] }, { id: 'ap', type: 'approval', config: { message: 'OK to go?' }, next: ['t'] }, { id: 't', type: 'task', config: { title: 'Approved task', project: 'shop' } }] } });
    const items = await fetch(base + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'task', title: 'Ship it', project: 'shop' }) }).then((r) => r.json());
    await fetch(base + '/api/items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: items.id, status: 'done' }) });
    let fired = false; for (let i = 0; i < 20 && !fired; i++) { await sleep(250); fired = JSON.stringify(await (await fetch(base + '/api/notifications')).json()).includes('Finished: Ship it'); }
    assert.ok(fired, 'a task.done workflow fires when a task is finished');
    const list = (await (await fetch(base + '/api/workflows')).json()).workflows; const apId = list.find((w) => w.name === 'Approve').id;
    const w1 = await post({ action: 'run', id: apId, trigger: {} }); assert.equal(w1.j.run.status, 'waiting');
    const a1 = await post({ action: 'approve', run: w1.j.run.id }); assert.equal(a1.j.run.status, 'done');
    assert.ok(new Store(v2).list('task').some((t) => t.title === 'Approved task'));
    ok('server: task.done trigger fires; approval waits and continues when approved');

    // page (desktop + phone)
    let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* no browser */ }
    if (!chromium) console.log('  (no browser available: skipping the page check)');
    else {
      const browser = await chromium.launch();
      try {
        for (const [name, vp] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
          const page = await (await browser.newContext({ viewport: vp })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
          await page.addInitScript(() => { try { localStorage.setItem('cortex.tourDone', '1'); } catch { /* private */ } });
          await page.goto(base + '/#/workflows'); await page.waitForSelector('#wf-tpl .wf-item');
          await page.click('#wf-tpl .wf-item >> nth=1');
          assert.ok(await page.locator('.wf-node').count() >= 5, `${name}: template steps on the canvas`);
          page.once('dialog', (d) => d.accept('quantum widgets'));
          await page.click('#wf-test'); await page.waitForSelector('.wf-run', { timeout: 8000 }).catch(async () => { throw new Error(`${name}: no run shown; page says: ${(await page.locator('body').innerText()).slice(-400)}`); });
          const log = await page.locator('.wf-run').first().innerText(); assert.ok(/done/.test(log) && /research/.test(log), `${name}: test run log shown (${log.slice(0, 120)})`);
          await page.click('[data-add="notify"]'); assert.ok(await page.locator('#wf-ed [data-c="title"]').count(), `${name}: new step opens in the editor`);
          if (name === 'desktop') await page.screenshot({ path: path.join(T, 'wf.png') });
          assert.deepEqual(errs, [], `${name}: no page errors`);
        }
      } finally { await browser.close(); }
      ok('page: templates load onto the canvas, a free test run shows its step log, steps can be added and edited (desktop + phone)');
    }
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} workflow checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
