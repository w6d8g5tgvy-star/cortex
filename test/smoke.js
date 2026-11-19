'use strict';
// End-to-end smoke test: MCP over stdio, MCP over HTTP, and the REST API, against a temp vault.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cortex.js');
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
const port = 17000 + Math.floor(Math.random() * 2000);
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

function stdioClient() {
  const p = spawn(process.execPath, [CLI, 'mcp', '--vault', vault], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { call, close: () => p.kill(), notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}
const tool = async (c, name, args) => {
  const r = await c.call('tools/call', { name, arguments: args });
  const text = r.result.content[0].text;
  if (r.result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
};

(async () => {
  console.log('stdio MCP');
  const c = stdioClient();
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1.0' } });
  assert.equal(init.result.serverInfo.name, 'cortex');
  assert.ok(init.result.instructions.includes('cortex_start'));
  c.notify('notifications/initialized');
  ok('initialize');
  const list = await c.call('tools/list', {});
  assert.ok(list.result.tools.length >= 15);
  ok(`tools/list (${list.result.tools.length} tools)`);
  const start = await tool(c, 'cortex_start', {});
  assert.ok(start.projects.some((p) => p.slug === 'getting-started'));
  ok('cortex_start returns seeded project');
  const proj = await tool(c, 'project_create', { title: 'Website Redesign', description: 'New marketing site' });
  assert.equal(proj.slug, 'website-redesign');
  const task = await tool(c, 'task_create', { title: 'Design hero section', project: 'Website Redesign', priority: 'high', tags: ['design'] });
  assert.equal(task.project, 'website-redesign');
  await tool(c, 'task_update', { id: task.id, status: 'doing', append_note: 'Started wireframes' });
  const got = await tool(c, 'task_get', { id: 'Design hero section' });
  assert.equal(got.status, 'doing');
  assert.ok(got.body.includes('Started wireframes'));
  ok('project + task create/update/get');
  const mem = await tool(c, 'memory_write', { title: 'Brand colors', content: 'Primary is #5b4cf0. See [[Website Redesign]] and [[Missing Note]].', project: 'website-redesign', tags: ['brand'] });
  assert.deepEqual(mem.links, ['projects/website-redesign']);
  assert.deepEqual(mem.unresolved_links, ['Missing Note']);
  const hits = await tool(c, 'memory_search', { query: 'primary color' });
  assert.equal(hits[0].id, 'notes/website-redesign/brand-colors');
  await tool(c, 'memory_update', { id: 'Brand colors', append: 'Secondary is teal.' });
  const g = await tool(c, 'memory_get', { id: 'notes/website-redesign/brand-colors' });
  assert.ok(g.body.includes('Secondary is teal.'));
  const links = await tool(c, 'memory_links', { id: 'projects/website-redesign' });
  assert.ok(links.backlinks.some((b) => b.id === 'notes/website-redesign/brand-colors'));
  ok('memory write/search/update/get/links');
  const bad = await c.call('tools/call', { name: 'task_update', arguments: { id: task.id, status: 'nope' } });
  assert.equal(bad.result.isError, true);
  ok('invalid input returns isError');
  await tool(c, 'activity_log', { summary: 'Finished the smoke test', action: 'tested' });
  const acts = await tool(c, 'activity_list', { agent: 'test-agent' });
  assert.ok(acts.some((a) => a.summary === 'Finished the smoke test'));
  ok('activity log attributed to client name');
  c.close();

  const md = fs.readFileSync(path.join(vault, 'notes', 'website-redesign', 'brand-colors.md'), 'utf8');
  assert.ok(md.startsWith('---\ntitle: Brand colors\n'));
  ok('project memory stored as Markdown in its project folder');

  console.log('HTTP server + MCP');
  const srv = spawn(process.execPath, [CLI, 'start', '--vault', vault, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('running') && res()));
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) => fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const r1 = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-agent' } } });
  const sid = r1.headers.get('mcp-session-id');
  assert.ok(sid);
  assert.equal((await r1.json()).result.protocolVersion, '2025-03-26');
  const r2 = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': sid });
  assert.equal(r2.status, 202);
  const r3 = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_list', arguments: { project: 'website-redesign' } } }, { 'Mcp-Session-Id': sid });
  const tl = JSON.parse((await r3.json()).result.content[0].text);
  assert.equal(tl[0].title, 'Design hero section');
  ok('HTTP MCP initialize/session/tools');
  const evil = await fetch(base + '/api/state', { headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'http://127.0.0.1:1' } })).status, 403);
  const sameOrigin = await fetch(base + '/api/state', { headers: { Origin: base } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get('x-content-type-options'), 'nosniff');
  ok('cross-origin requests blocked');
  const state = await (await fetch(base + '/api/state')).json();
  assert.ok(state.tasks.length >= 5 && state.notes.length >= 3);
  const created = await (await fetch(base + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'note', title: 'From dashboard', body: 'Hi [[Brand colors]]' }) })).json();
  const item = await (await fetch(base + '/api/item?id=' + encodeURIComponent('notes/website-redesign/brand-colors'))).json();
  assert.ok(item.backlinks.some((b) => b.id === created.id));
  ok('REST API + backlinks');
  // external edit (e.g. from Obsidian) is picked up
  fs.writeFileSync(path.join(vault, 'notes', 'obsidian-note.md'), '# Written in Obsidian\n\nLinks to [[From dashboard]] #external\n');
  await new Promise((r) => setTimeout(r, 2600));
  const s2 = await (await fetch(base + '/api/search?q=obsidian')).json();
  assert.ok(s2.some((h) => h.title === 'Written in Obsidian'));
  ok('external file edits are synced');
  srv.kill();
  fs.rmSync(vault, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
