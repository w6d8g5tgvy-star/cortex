'use strict';
// A connected MCP app keeps its name after Cortex restarts (updates restart Cortex).
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-restart-'));
const vault = path.join(tmp, 'vault');
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const port = 17000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const start = () => spawn(process.execPath, [path.join(ROOT, 'bin', 'cortex.js'), 'serve', '--vault', vault, '--port', String(port)], { env: { ...process.env, USERPROFILE: home, HOME: home }, stdio: 'ignore', windowsHide: true });
const up = async () => { for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); return; } catch { await new Promise((r) => setTimeout(r, 250)); } } throw new Error('server did not start'); };
const down = (p) => new Promise((r) => { p.once('exit', r); p.kill(); });
const rpc = async (body, sid) => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
  return { sid: r.headers.get('mcp-session-id'), status: r.status };
};

(async () => {
  console.log('Restart');
  let srv = start();
  try {
    await up();
    const { sid } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' } } });
    assert.ok(sid, 'session id returned');
    await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'live_update', arguments: { step: 'hi', model: 'restart-model-1' } } }, sid);
    await new Promise((r) => setTimeout(r, 900)); // sessions are saved shortly after initialize
    await down(srv);
    srv = start();
    await up();
    await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'activity_log', arguments: { summary: 'after restart' } } }, sid);
    const acts = fs.readFileSync(path.join(vault, '.cortex', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = acts.filter((a) => a.summary === 'after restart').pop();
    assert.equal(last && last.agent, 'restart-test');
    assert.equal(last.model, 'restart-model-1', 'and its model');
    console.log('  ✓ a connected app keeps its name and model after Cortex restarts');

    // an app using a session id Cortex never saw gets ONE card, not one per call
    const ghost = 'ghost-session-0123456789';
    for (let i = 0; i < 3; i++) await rpc({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'live_update', arguments: { step: 'step ' + i } } }, ghost);
    const cards = fs.readdirSync(path.join(vault, '.cortex', 'sessions')).filter((f) => f.startsWith('mcp-ghost-sessi'));
    assert.equal(cards.length, 1, `one card for an unknown session (got ${cards.length})`);
    console.log('  ✓ an app with an unknown session gets one card instead of a new card per call');
    console.log('\nAll restart checks passed.');
  } finally {
    await down(srv).catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows may hold a file briefly */ }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
