'use strict';
// Unified AI conversations (#21): shared project context, automatic routing, continuation, model switching without
// losing the thread, attachments, saving answers as memories, handoffs to other agents, and the Chat page.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const chat = require('../src/conversations');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')); const v = path.join(T, 'v'); const st = new Store(v);
  st.create('project', { title: 'Shop' });

  // ---------- unit ----------
  const c = chat.create(v, { project: 'shop' });
  chat.addUser(v, c.id, { text: 'What payment provider do we use?' });
  assert.equal(chat.get(v, c.id).title, 'What payment provider do we use?', 'first message names the conversation');
  const m1 = chat.addPending(v, c.id, { tool: 'claude', model: 'sonnet', runId: 'run-1' });
  assert.throws(() => chat.addUser(v, c.id, { text: 'again' }), /Wait for the answer/);
  chat.complete(v, c.id, m1.id, { status: 'done', text: 'Stripe.', model: 'claude-sonnet-x', session: 'sess-A' });
  let cc = chat.get(v, c.id);
  assert.deepEqual(cc.sessions.claude, { session: 'sess-A', model: 'sonnet' });
  const same = chat.plan(v, cc, { text: 'And refunds?', tool: 'claude', model: 'sonnet' });
  assert.equal(same.resume, 'sess-A'); assert.equal(same.prompt, 'And refunds?', 'same model continues its own session with just the new message');
  const other = chat.plan(v, cc, { text: 'And refunds?', tool: 'claude', model: 'opus' });
  assert.equal(other.resume, null); assert.ok(other.prompt.includes('User: What payment provider do we use?') && other.prompt.includes('Assistant (claude-sonnet-x): Stripe.') && /different AI model/.test(other.prompt), 'switching model carries the transcript');
  const cx = chat.plan(v, cc, { text: 'x', tool: 'codex' }); assert.equal(cx.resume, null, 'Codex gets the transcript (no resume claimed)');
  const long = chat.create(v, {}); const lc = chat.get(v, long.id); for (let i = 0; i < 60; i++) lc.messages.push({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(500) + i, tool: 'claude' });
  const tr = chat.transcript(lc); assert.ok(tr.length <= chat.MAX_TRANSCRIPT + 60 && tr.startsWith('[earlier messages shortened]') && tr.includes('59'));
  fs.mkdirSync(path.join(v, 'attachments', 'shop'), { recursive: true }); fs.writeFileSync(path.join(v, 'attachments', 'shop', 'spec.md'), '# Spec\nRefunds within 30 days.');
  const at = chat.attachmentText(v, [{ name: 'spec.md', path: 'attachments/shop/spec.md' }, { name: 'logo.png', path: 'attachments/shop/logo.png' }, { name: 'evil', path: '../../etc/passwd' }]);
  assert.ok(at.includes('Refunds within 30 days') && /logo.png: file not found/.test(at) && /evil: file not found/.test(at));
  assert.ok(chat.handoffText(cc, 'Implement refunds').includes('What to do: Implement refunds'));
  ok('conversations: continue the same session, switch model/tool with the transcript, long chats shortened, attachments read safely, handoff text');

  // ---------- server with a fake Claude CLI ----------
  const fakeBin = path.join(T, 'fake-claude');
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const a=process.argv.slice(2);let i='';process.stdin.on('data',d=>i+=d).on('end',()=>{
const r=a.includes('--resume')?a[a.indexOf('--resume')+1]:'none';const m=a.includes('--model')?a[a.indexOf('--model')+1]:'default';
const K="User's new message:";const last=i.includes(K)?i.split(K)[1].trim().split('\\n')[0]:i.trim().split('\\n')[0];
console.log(JSON.stringify({type:'system',subtype:'init',model:'fake-'+m,session_id:r==='none'?'sess-'+Date.now():r}));
setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',result:'resume='+r+' model='+m+' brief='+(i.includes('Cortex brief')?'yes':'no')+' earlier='+(i.includes('conversation so far')?'yes':'no')+' perm='+(a.includes('default')?'default':'other')+' att='+(i.includes('Refunds within 30 days')?'yes':'no')+' last='+last,num_turns:1,total_cost_usd:0.001})),150)});
`, { mode: 0o755 });
  const work = path.join(T, 'work'); fs.mkdirSync(work);
  const v2 = path.join(T, 'v2'); const st2 = new Store(v2); st2.create('project', { title: 'Shop' }); st2.create('note', { title: 'Payments', body: 'We use Stripe.', project: 'shop' });
  fs.mkdirSync(path.join(v2, '.cortex'), { recursive: true }); fs.writeFileSync(path.join(v2, '.cortex', 'settings.json'), JSON.stringify({ agents: { enabled: true, folders: [work] } }));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', v2, '--port', String(port)], { stdio: 'ignore', env: { ...process.env, CORTEX_CLAUDE_BIN: fakeBin, CORTEX_CODEX_BIN: path.join(T, 'no-codex') } });
  const base = `http://127.0.0.1:${port}`;
  const post = async (b) => { const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };
  const conv = async (id) => (await (await fetch(base + '/api/chat?id=' + id)).json()).conversation;
  const answer = async (id) => { for (let i = 0; i < 60; i++) { const x = await conv(id); const last = x.messages[x.messages.length - 1]; if (last.role === 'assistant' && !last.pending) return last; await sleep(250); } throw new Error('no answer'); };
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    const g = await (await fetch(base + '/api/chat')).json();
    assert.ok(g.tools.claude.installed && /can't be driven from here/.test(g.notSupported));
    const cr = await post({ action: 'create', project: 'shop' }); const id = cr.j.conversation.id;
    const s1 = await post({ action: 'send', id, text: 'Hi there', tool: 'claude', model: 'sonnet' }); assert.equal(s1.status, 202, JSON.stringify(s1.j));
    const a1 = await answer(id);
    assert.match(a1.text, /resume=none model=sonnet brief=yes earlier=no perm=default/); assert.match(a1.text, /last=Hi there/);
    assert.equal(a1.model, 'fake-sonnet');
    const s2 = await post({ action: 'send', id, text: 'Follow-up', tool: 'claude', model: 'sonnet' }); assert.ok(s2.j.resumed);
    const a2 = await answer(id); assert.match(a2.text, /resume=sess-\d+ model=sonnet brief=no/); assert.match(a2.text, /last=Follow-up/);
    const s3 = await post({ action: 'send', id, text: 'Now you', tool: 'claude', model: 'opus' }); assert.ok(!s3.j.resumed);
    const a3 = await answer(id); assert.match(a3.text, /resume=none model=opus brief=yes earlier=yes/);
    ok('server: first message gets the Cortex brief; same model continues its session; a model switch starts fresh with brief + transcript; chats can\'t edit files without asking');

    const s4 = await post({ action: 'send', id, text: 'Fix the login bug in auth.js', model: 'auto' }); assert.ok(s4.j.route && s4.j.route.reasons, 'automatic routing explains its pick');
    const a4 = await answer(id); assert.ok(a4.route && a4.route.model);
    fs.mkdirSync(path.join(v2, 'attachments', 'shop'), { recursive: true }); fs.writeFileSync(path.join(v2, 'attachments', 'shop', 'spec.md'), 'Refunds within 30 days.');
    await post({ action: 'send', id, text: 'Read this', tool: 'claude', model: 'opus', attachments: [{ name: 'spec.md', path: 'attachments/shop/spec.md' }] });
    const a5 = await answer(id); assert.match(a5.text, /att=yes/);
    assert.equal((await post({ action: 'send', id, text: 'x', tool: 'codex', model: '' })).status, 400, 'tools that aren\'t installed are refused, not faked');
    const rem = await post({ action: 'remember', id, message: a1.id }); assert.equal(rem.status, 201);
    assert.ok(new Store(v2).list('note', { project: 'shop' }).some((n) => n.title.startsWith('From chat:')));
    const ho = await post({ action: 'handoff', id, to: 'codex', note: 'Implement refunds' }); assert.equal(ho.j.command.kind, 'handoff');
    assert.ok(require('../src/agents').listCommands(v2).some((x) => x.target === 'codex' && x.text.includes('Implement refunds') && x.text.includes('Hi there')));
    ok('server: automatic routing, attachments in the prompt, uninstalled tools refused, answers saved as memories, handoff to another agent with the transcript');

    let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* none */ }
    if (!chromium) console.log('  (no browser available: skipping the page check)');
    else {
      const browser = await chromium.launch();
      try {
        for (const [name, vp] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
          const page = await (await browser.newContext({ viewport: vp })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
          await page.addInitScript(() => { try { localStorage.setItem('cortex.tourDone', '1'); } catch { /* private */ } });
          await page.goto(base + '/#/chat'); await page.waitForSelector('#ch-new');
          await page.click('#ch-new'); await page.waitForFunction(() => /Say hello/.test((document.querySelector('#ch-thread') || {}).innerText || ''));
          await page.selectOption('#ch-model', 'claude:haiku');
          await page.fill('#ch-text', `Hello from the ${name}`); await page.keyboard.press('Enter');
          await page.waitForFunction((n) => new RegExp('resume=none model=haiku.*last=Hello from the ' + n).test(document.querySelector('#ch-thread').innerText), name, { timeout: 15000 });
          await page.waitForTimeout(300); assert.ok(await page.locator('[data-rem]').count(), `${name}: answer can be saved as a memory: ${(await page.locator('#ch-thread').innerHTML()).slice(-700)}`);
          if (name === 'desktop') await page.screenshot({ path: path.join(T, 'chat.png') });
          assert.deepEqual(errs, [], `${name}: no page errors`);
        }
      } finally { await browser.close(); }
      ok('page: start a chat, pick a model, send with Enter, the answer appears (desktop + phone)');
    }
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} conversation checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
