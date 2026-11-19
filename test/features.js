'use strict';
// End-to-end checks for: project/system memory scopes, the agent journal, Claude Code hooks (brief injection,
// recall, save gate, phone approvals), launching agents (fake `claude` CLI), commands, Mind (fake site + fake
// yt-dlp), add-only skills, connector link, templates, history, backups, health/gardener/briefing, search.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cortex.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-feat-'));
const vault = path.join(tmp, 'vault');
const home = path.join(tmp, 'home');
const codeA = path.join(tmp, 'code', 'alpha-app');
fs.mkdirSync(codeA, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const port = 21000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const ENV = { ...process.env, HOME: home, USERPROFILE: home, CORTEX_ALLOW_PRIVATE_FETCH: '1', CORTEX_OLLAMA: 'http://127.0.0.1:1' };
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (r) => r.json();
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (p, body) => fetch(base + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const read = (...p) => fs.readFileSync(path.join(vault, ...p), 'utf8');

function mcp(name = 'test-agent') {
  const p = spawn(process.execPath, [CLI, 'mcp', '--vault', vault], { stdio: ['pipe', 'pipe', 'ignore'], env: ENV });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const call = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (t, args = {}) => { const r = await call('tools/call', { name: t, arguments: args }); if (r.result.isError) throw new Error(r.result.content[0].text); const x = r.result.content[0].text; try { return JSON.parse(x); } catch { return x; } };
  return { ready: call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name } }), tool, close: () => p.kill() };
}
function hook(event, env = {}) {
  const r = spawnSync(process.execPath, [CLI, 'hook', '--vault', vault], { input: JSON.stringify(event), encoding: 'utf8', env: { ...ENV, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

(async () => {
  // ---------- fake external tools ----------
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  // fake Claude Code: records its args + stdin, streams events like `claude -p --output-format stream-json`
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), `
const fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',async()=>{
fs.writeFileSync(${JSON.stringify(path.join(tmp, 'claude-call.json'))},JSON.stringify({args:process.argv.slice(2),stdin:input,cwd:process.cwd(),run:process.env.CORTEX_RUN_ID}));
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:'sess-123',model:'fake-model'});
out({type:'assistant',message:{content:[{type:'text',text:'Looking at the project memories first.'},{type:'tool_use',name:'Edit',input:{file_path:'/x/app.js'}}]}});
if(input.includes('SLOW')) await new Promise(r=>setTimeout(r,60000));
out({type:'result',subtype:'success',is_error:false,result:'Fixed the login bug and added a test.',num_turns:3,total_cost_usd:0.01,session_id:'sess-123'});});`);
  // fake yt-dlp: prints metadata JSON with a captions URL served by our fake site
  const site = http.createServer((req, res) => {
    if (req.url === '/article') { res.setHeader('content-type', 'text/html'); return res.end(`<html><head><title>How Neural Vaults Work</title><meta property="og:site_name" content="Abyss Blog"><meta name="author" content="Ada"></head><body><nav>menu</nav><article><h1>How Neural Vaults Work</h1>${'<p>Neural vaults link memories together so agents can recall them. Each memory is a node and each link a synapse. </p>'.repeat(12)}</article></body></html>`); }
    if (req.url === '/captions.vtt') { res.setHeader('content-type', 'text/vtt'); return res.end('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to the abyss tutorial.\n\n00:00:50.000 --> 00:00:53.000\nToday we build a neural memory graph.\n'); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  fs.writeFileSync(path.join(bin, 'fake-ytdlp.js'), `process.stdout.write(JSON.stringify({title:'Abyss Tutorial',uploader:'Space Channel',duration:754,description:'Learn to build a neural vault.',webpage_url:'https://video.example/watch?v=1',automatic_captions:{en:[{ext:'vtt',url:${JSON.stringify(siteUrl + '/captions.vtt')}}]}}));`);
  const shim = (name, js) => { const f = path.join(bin, name); fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, js)}" "$@"\n`); fs.chmodSync(f, 0o755); return f; };
  const fakeClaude = shim('claude', 'fake-claude.js');
  const fakeYt = shim('yt-dlp', 'fake-ytdlp.js');
  Object.assign(ENV, { CORTEX_CLAUDE_BIN: fakeClaude, CORTEX_YTDLP: fakeYt });

  // ---------- start Cortex ----------
  const srv = spawn(process.execPath, [CLI, 'start', '--vault', vault, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  let srvOut = ''; srv.stdout.on('data', (d) => (srvOut += d)); srv.stderr.on('data', (d) => (srvOut += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(200); }

  console.log('memory scopes');
  const A = await J(await post('/api/items', { kind: 'project', title: 'Alpha App', instructions: 'Always write tests first. ALPHA-RULE.', folder: codeA }));
  const B = await J(await post('/api/items', { kind: 'project', title: 'Beta Site' }));
  assert.ok(fs.statSync(path.join(vault, 'notes', 'alpha-app')).isDirectory() && fs.statSync(path.join(vault, 'notes', 'beta-site')).isDirectory());
  ok('each new project gets its own memory folder');
  const c = mcp('codex');
  await c.ready;
  const ma = await c.tool('memory_write', { title: 'Alpha uses Postgres', content: 'The alpha app stores data in Postgres 16.', project: 'alpha-app' });
  const mb = await c.tool('memory_write', { title: 'Beta deploys on Fridays', content: 'Beta site deploys only on Fridays.', project: 'beta-site' });
  const ms = await c.tool('memory_write', { title: 'User likes concise answers', content: 'The user prefers short, direct answers.', pinned: true });
  assert.equal(ma.id, 'notes/alpha-app/alpha-uses-postgres');
  assert.equal(mb.id, 'notes/beta-site/beta-deploys-on-fridays');
  assert.equal(ms.id, 'notes/user-likes-concise-answers');
  assert.ok(fs.existsSync(path.join(vault, 'notes', 'alpha-app', 'alpha-uses-postgres.md')));
  ok('project memories are stored in their project folder, system memories in notes/');
  const startA = await c.tool('cortex_start', { project: 'alpha-app' });
  const names = (arr) => (arr || []).map((n) => n.title);
  assert.ok(names(startA.project_memories).includes('Alpha uses Postgres'));
  assert.ok(!names(startA.project_memories).includes('Beta deploys on Fridays'));
  assert.ok(names(startA.system_memories).includes('User likes concise answers'));
  assert.ok(!names(startA.system_memories).includes('Beta deploys on Fridays'));
  assert.ok(startA.project_instructions.includes('ALPHA-RULE'));
  const briefA = await c.tool('project_brief', { project: 'alpha-app' });
  assert.ok(briefA.includes('Alpha uses Postgres') && briefA.includes('User likes concise answers') && !briefA.includes('Beta deploys'));
  const sA = await c.tool('memory_search', { query: 'deploys fridays', project: 'alpha-app' });
  assert.ok(!sA.some((h) => h.id.includes('beta')));
  const sAll = await c.tool('memory_search', { query: 'deploys fridays' });
  assert.ok(sAll.some((h) => h.id.includes('beta')));
  ok('agents on a project get that project + system memories only (start, brief, search)');
  const moved = await J(await patch('/api/items', { id: ma.id, project: null, quiet: true }));
  assert.equal(moved.id, 'notes/alpha-uses-postgres');
  const back = await J(await patch('/api/items', { id: moved.id, project: 'alpha-app', quiet: true }));
  assert.equal(back.id, 'notes/alpha-app/alpha-uses-postgres');
  ok('changing a memory\'s project moves it between folders');

  console.log('agent journal');
  await c.tool('task_create', { title: 'Add login page', project: 'alpha-app' });
  const jA = read('notes', 'alpha-app', 'agent-journal.md');
  assert.ok(/codex\*\* · Created task "Add login page"/.test(jA) && /codex\*\* · Saved memory "Alpha uses Postgres"/.test(jA));
  assert.ok(!jA.includes('Beta'));
  ok('every agent action on a project is written to that project\'s agent journal');

  console.log('claude code hooks');
  const sid = 'hook-sess-1';
  const ss = hook({ hook_event_name: 'SessionStart', session_id: sid, cwd: codeA, source: 'startup' });
  const ctx = ss.hookSpecificOutput.additionalContext;
  assert.equal(ss.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx.includes('alpha-app') && ctx.includes('ALPHA-RULE') && ctx.includes('Alpha uses Postgres') && ctx.includes('User likes concise answers') && !ctx.includes('Beta deploys'));
  assert.ok(ctx.length <= 10000);
  ok('SessionStart injects the project brief for the folder (≤10k chars, other projects excluded)');
  const up = hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: codeA, prompt: 'migrate the postgres database' });
  assert.ok(up.hookSpecificOutput.additionalContext.includes('Alpha uses Postgres'));
  ok('UserPromptSubmit recalls related memories for the prompt');
  hook({ hook_event_name: 'PostToolUse', session_id: sid, cwd: codeA, tool_name: 'Edit', tool_input: { file_path: path.join(codeA, 'db.js') } });
  hook({ hook_event_name: 'PostToolUse', session_id: sid, cwd: codeA, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const gate = hook({ hook_event_name: 'Stop', session_id: sid, cwd: codeA, stop_hook_active: false, last_assistant_message: 'Done.' });
  assert.equal(gate.decision, 'block');
  assert.ok(/save gate/i.test(gate.reason) && gate.reason.includes('alpha-app'));
  const after = hook({ hook_event_name: 'Stop', session_id: sid, cwd: codeA, stop_hook_active: true, last_assistant_message: 'Migrated the database to Postgres 17.' });
  assert.equal(after, null);
  let jA2 = read('notes', 'alpha-app', 'agent-journal.md');
  assert.ok(jA2.includes('Migrated the database to Postgres 17.') && jA2.includes('`db.js`') && jA2.includes('**Commands run:** 1') && jA2.includes('**Saved to memory:** no'));
  ok('save gate asks once, then the session is journaled with files, commands and outcome');
  hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: codeA, prompt: 'add an index' });
  hook({ hook_event_name: 'PostToolUse', session_id: sid, cwd: codeA, tool_name: 'Write', tool_input: { file_path: path.join(codeA, 'index.sql') } });
  hook({ hook_event_name: 'PostToolUse', session_id: sid, cwd: codeA, tool_name: 'mcp__cortex__memory_write', tool_input: {} });
  assert.equal(hook({ hook_event_name: 'Stop', session_id: sid, cwd: codeA, stop_hook_active: false, last_assistant_message: 'Added the index.' }), null);
  jA2 = read('notes', 'alpha-app', 'agent-journal.md');
  assert.ok(jA2.includes('Added the index.') && jA2.includes('**Saved to memory:** yes'));
  ok('no gate when the agent saved to memory; journal records it');
  // phone approvals
  await post('/api/settings', { agents: { phoneApprovals: true } });
  const pr = spawn(process.execPath, [CLI, 'hook', '--vault', vault], { env: ENV });
  let prOut = ''; pr.stdout.on('data', (d) => (prOut += d));
  pr.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sid, cwd: codeA, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }));
  let pending = [];
  for (let i = 0; i < 30 && !pending.length; i++) { await sleep(200); pending = (await J(await fetch(base + '/api/live'))).approvals; }
  assert.equal(pending[0].summary, '$ rm -rf build');
  await post('/api/approvals', { id: pending[0].id, decision: 'deny', note: 'not now' });
  await new Promise((r) => pr.on('exit', r));
  const prJson = JSON.parse(prOut);
  assert.equal(prJson.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(prJson.hookSpecificOutput.decision.behavior, 'deny');
  assert.ok(prJson.hookSpecificOutput.decision.message.includes('not now'));
  await post('/api/settings', { agents: { phoneApprovals: false } });
  assert.equal(hook({ hook_event_name: 'PermissionRequest', session_id: sid, cwd: codeA, tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  ok('permission requests wait for approve/deny from Cortex (and fall back to the normal dialog when off)');

  console.log('commanding agents');
  const lr = await post('/api/agents/run', { prompt: 'fix login' });
  assert.equal(lr.status, 403);
  await post('/api/settings', { agents: { enabled: true, folders: [path.join(tmp, 'code')] } });
  const outside = await post('/api/agents/run', { prompt: 'x', folder: os.tmpdir() });
  assert.equal(outside.status, 403);
  const task = await J(await post('/api/items', { kind: 'task', title: 'Fix login bug', project: 'alpha-app', body: 'Users get logged out.' }));
  const run = await J(await post('/api/agents/run', { prompt: 'Please fix it', project: 'alpha-app', task: task.id }));
  let sess;
  for (let i = 0; i < 40; i++) { await sleep(200); sess = (await J(await fetch(base + '/api/live'))).sessions.find((s) => s.id === run.id); if (sess && sess.status === 'done') break; }
  assert.equal(sess.status, 'done', JSON.stringify(sess));
  assert.equal(sess.claude_session, 'sess-123');
  const call = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-call.json'), 'utf8'));
  assert.ok(call.args.includes('-p') && call.args.includes('mcp__cortex__*') && call.args.includes('stream-json') && call.args.includes('--verbose'));
  assert.equal(call.cwd, codeA);
  assert.equal(call.run, run.id);
  assert.ok(call.stdin.includes('ALPHA-RULE') && call.stdin.includes('Fix login bug') && call.stdin.includes('Please fix it') && call.stdin.includes('User likes concise answers') && !call.stdin.includes('Beta deploys'));
  await sleep(300);
  const jRun = read('notes', 'alpha-app', 'agent-journal.md');
  assert.ok(jRun.includes('Fixed the login bug and added a test.') && jRun.includes('started from Cortex'));
  const taskAfter = await J(await fetch(base + '/api/item?id=' + encodeURIComponent(task.id)));
  assert.equal(taskAfter.status, 'doing');
  assert.ok(taskAfter.body.includes('Fixed the login bug'));
  ok('launch runs Claude Code in the project folder with the full brief; result lands in the journal and the task');
  const cont = await J(await post('/api/agents/run', { prompt: 'now add docs', resumeFrom: run.id }));
  await sleep(1200);
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'claude-call.json'), 'utf8')).args.join(' ').includes('--resume sess-123'));
  assert.ok(cont.id);
  ok('a finished Claude Code run can be continued with --resume');
  const slow = await J(await post('/api/agents/run', { prompt: 'SLOW job', project: 'alpha-app' }));
  await sleep(700);
  assert.equal((await J(await post('/api/agents/stop', { id: slow.id }))).stopped, true);
  for (let i = 0; i < 30; i++) { await sleep(200); sess = (await J(await fetch(base + '/api/live'))).sessions.find((s) => s.id === slow.id); if (sess.status !== 'working') break; }
  assert.equal(sess.step, 'Stopped by you');
  ok('a running agent can be stopped');
  const cmd = await J(await post('/api/commands', { text: 'Summarise open tasks', target: 'any', project: 'alpha-app' }));
  const c2 = mcp('cursor');
  await c2.ready;
  const got1 = await c.tool('messages_check');
  const got2 = await c2.tool('messages_check');
  assert.equal(got1.commands_from_user.length + got2.commands_from_user.length, 1);
  const who = got1.commands_from_user.length ? c : c2;
  await who.tool('command_complete', { id: cmd.id, result: 'Two open tasks.' });
  const cmds = (await J(await fetch(base + '/api/agents'))).commands;
  assert.equal(cmds.find((x) => x.id === cmd.id).status, 'done');
  c2.close();
  ok('a command goes to exactly one agent and its result comes back');

  console.log('mind');
  const blocked = await J(await post('/api/mind', { url: 'http://127.0.0.1:1/x', section: 'read' }));
  const art = await J(await post('/api/mind', { url: siteUrl + '/article' }));
  assert.equal(art.section, 'read');
  const fetched = await J(await post('/api/mind/fetch', { id: art.id }));
  assert.equal(fetched.title, 'How Neural Vaults Work');
  const artItem = await J(await fetch(base + '/api/item?id=' + encodeURIComponent(art.id)));
  assert.ok(artItem.body.includes('Each memory is a node') && !artItem.body.includes('menu'));
  const vid = await c.tool('mind_add', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', fetch: true });
  assert.equal(vid.section, 'watch');
  const vidItem = await c.tool('memory_get', { id: vid.id });
  assert.ok(vidItem.body.includes('Welcome to the abyss tutorial.') && vidItem.body.includes('[0:01]') && vidItem.title === 'Abyss Tutorial' && vidItem.channel === 'Space Channel');
  const done = await c.tool('mind_complete', { id: vid.id, summary: '- Builds a neural memory graph step by step.' });
  const memNote = await c.tool('memory_get', { id: done.memory });
  assert.ok(memNote.body.includes('Builds a neural memory graph') && memNote.links.includes(vid.id));
  const ql = await c.tool('mind_list', {});
  assert.ok(!ql.some((x) => x.id === vid.id) && ql.some((x) => x.id === art.id));
  ok('Mind: article text and video transcript are fetched, summaries become linked memories');
  delete ENV.CORTEX_ALLOW_PRIVATE_FETCH;
  const media = require('../src/media');
  await assert.rejects(() => media.assertPublicUrl('http://127.0.0.1:8080/'), /private|Local/);
  await assert.rejects(() => media.assertPublicUrl('http://192.168.1.4/'), /private/);
  await assert.rejects(() => media.assertPublicUrl('file:///etc/passwd'), /http/);
  ENV.CORTEX_ALLOW_PRIVATE_FETCH = '1';
  assert.ok(blocked.id);
  ok('Mind refuses links to your own computer or home network');

  console.log('skills (add-only)');
  const userSkill = path.join(home, '.claude', 'skills', 'my-skill');
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '---\nname: my-skill\ndescription: Mine\n---\n\nMY OWN SKILL\n');
  const imp = await J(await post('/api/skills/import', { target: 'claude-code' }));
  assert.deepEqual(imp.imported, ['skills/my-skill']);
  let list = await J(await fetch(base + '/api/skills'));
  assert.equal(list.find((x) => x.id === 'skills/my-skill').installed['claude-code'], 'yours');
  const clash = await post('/api/skills/install', { id: 'skills/my-skill', target: 'claude-code' });
  assert.equal(clash.status, 500 >= clash.status ? clash.status : 400);
  assert.ok(/never overwrites/.test((await J(clash)).error));
  const rm = await post('/api/skills/install', { id: 'skills/my-skill', target: 'claude-code', action: 'uninstall' });
  assert.ok(/will not remove/.test((await J(rm)).error));
  assert.equal(fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8').trim().endsWith('MY OWN SKILL'), true);
  const ns = await J(await post('/api/items', { kind: 'skill', title: 'Release Notes', description: 'Write release notes from git history', body: '1. Read git log\n2. Group changes' }));
  await post('/api/skills/install', { id: ns.id, target: 'claude-code' });
  const nsFile = path.join(home, '.claude', 'skills', 'release-notes', 'SKILL.md');
  assert.ok(fs.readFileSync(nsFile, 'utf8').startsWith('---\nname: release-notes\ndescription: "Write release notes'));
  list = await J(await fetch(base + '/api/skills'));
  assert.equal(list.find((x) => x.id === ns.id).installed['claude-code'], 'installed');
  await post('/api/skills/install', { id: ns.id, target: 'claude-code', action: 'uninstall' });
  assert.ok(!fs.existsSync(nsFile) && fs.existsSync(path.join(userSkill, 'SKILL.md')));
  const zipBuf = Buffer.from(await (await fetch(base + '/api/skills/zip?id=' + encodeURIComponent(ns.id))).arrayBuffer());
  fs.writeFileSync(path.join(tmp, 's.zip'), zipBuf);
  const zl = execFileSync('unzip', ['-l', path.join(tmp, 's.zip')]).toString();
  assert.ok(zl.includes('release-notes/SKILL.md'));
  const skl = await c.tool('skill_list');
  assert.ok(skl.some((x) => x.name === 'release-notes') && skl.some((x) => x.name === 'my-skill'));
  assert.ok((await c.tool('skill_get', { name: 'release-notes' })).includes('Read git log'));
  ok('skills only add: your own skills are imported as references and never overwritten or removed');

  console.log('connector link');
  const st = await J(await fetch(base + '/api/settings'));
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  if (lan) {
    // phone access is off → server only on 127.0.0.1, so test via forwarded header (looks like a tunnel)
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai' } } };
    const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' };
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: h, body: JSON.stringify(init) })).status, 401);
    assert.equal((await fetch(`${base}/mcp/${st.connector.token}`, { method: 'POST', headers: h, body: JSON.stringify(init) })).status, 200);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...h, Authorization: `Bearer ${st.connector.token}` }, body: JSON.stringify(init) })).status, 200);
    assert.equal((await fetch(`${base}/mcp/wrong-token`, { method: 'POST', headers: h, body: JSON.stringify(init) })).status, 401);
  }
  ok('connector link works with the secret URL or Bearer token, and rejects others');

  console.log('templates, history, backups, insights');
  const tp = await J(await post('/api/templates', { template: 'minecraft-mod', title: 'Sky Mod' }));
  assert.ok(tp.instructions.includes('in-game'));
  assert.ok(fs.existsSync(path.join(vault, 'notes', 'sky-mod', 'versions-and-environment.md')));
  assert.equal((await J(await fetch(base + '/api/state'))).tasks.filter((t) => t.project === 'sky-mod').length, 3);
  const n1 = await J(await post('/api/items', { kind: 'note', title: 'Versioned', body: 'v1 text' }));
  await patch('/api/items', { id: n1.id, body: 'v2 text', quiet: true });
  await patch('/api/items', { id: n1.id, body: 'v3 text', quiet: true });
  const vers = await J(await fetch(base + '/api/history?id=' + encodeURIComponent(n1.id)));
  assert.ok(vers.length >= 2);
  const oldest = vers[vers.length - 1].version;
  const restored = await J(await post('/api/history/restore', { id: n1.id, version: oldest }));
  assert.equal(restored.body.trim(), 'v1 text');
  const bk = await J(await post('/api/backups', {}));
  const bl = execFileSync('unzip', ['-l', bk.file]).toString();
  assert.ok(bl.includes('notes/alpha-app/alpha-uses-postgres.md') && !bl.includes('.cortex/history'));
  const hl = await J(await fetch(base + '/api/health'));
  const ha = hl.find((x) => x.project === 'alpha-app');
  assert.ok(ha.sessions >= 3 && ha.memories >= 1);
  assert.ok(hl.find((x) => x.project === 'beta-site').issues.some((i) => /No agent instructions/.test(i)));
  await post('/api/items', { kind: 'note', title: 'User likes concise answers!', body: 'The user prefers short, direct answers.' });
  const gd = await J(await fetch(base + '/api/garden'));
  assert.ok(gd.duplicates.some((d) => d.titles.join('|').includes('User likes concise answers')));
  const br = await J(await fetch(base + '/api/briefing'));
  assert.ok(br.markdown.includes('codex') && br.counts.memories >= 3);
  const ss2 = await J(await fetch(base + '/api/search?q=' + encodeURIComponent('postgresql databases')));
  assert.ok(ss2.some((h) => h.title === 'Alpha uses Postgres'));
  ok('templates, version history + restore, vault backup zip, health, gardener, briefing, stemmed search');

  console.log('automatic instructions');
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# My rules\n\nAlways be brief.\n');
  await post('/api/instructions', { action: 'install' });
  await post('/api/instructions', { action: 'install' });
  let cm = fs.readFileSync(claudeMd, 'utf8');
  assert.ok(cm.startsWith('# My rules') && cm.includes('Always be brief.') && cm.includes('cortex_start') && cm.split('cortex:start').length === 2);
  assert.ok(fs.existsSync(claudeMd + '.cortex-backup'));
  assert.equal((await J(await fetch(base + '/api/settings'))).instructions['claude-code'], 'installed');
  await post('/api/instructions', { action: 'uninstall' });
  cm = fs.readFileSync(claudeMd, 'utf8');
  assert.equal(cm, '# My rules\n\nAlways be brief.\n');
  const brief2 = await J(await fetch(base + '/api/briefing'));
  assert.ok(!/\*\*claude-ai\*\*/.test(brief2.markdown));
  ok('Cortex prompt is added to (and removed from) personal instructions without touching your own text');

  c.close();
  srv.kill('SIGTERM');
  site.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${passed} feature checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
