'use strict';
// Every task reports its model: MCP agents (self-reported), Claude Code (session log), Codex (its log), Cortex runs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-models-'));
const home = path.join(tmp, 'home');
process.env.USERPROFILE = home; process.env.HOME = home;
fs.mkdirSync(home, { recursive: true });
const vault = path.join(tmp, 'vault');
const ok = (m) => console.log('  ✓ ' + m);

(async () => {
  console.log('Model reporting');
  const models = require(path.join(ROOT, 'src', 'models.js'));
  const { Store } = require(path.join(ROOT, 'src', 'store.js'));
  const { createMcp } = require(path.join(ROOT, 'src', 'mcp.js'));
  const sessions = require(path.join(ROOT, 'src', 'sessions.js'));
  const hooks = require(path.join(ROOT, 'src', 'claude-hooks.js'));

  assert.equal(models.cleanModelName(' claude-opus-5-5 '), 'claude-opus-5-5');
  assert.equal(models.cleanModelName('<synthetic>'), undefined);
  assert.equal(models.cleanModelName('x; rm -rf /'), undefined);
  ok('model names are cleaned (placeholders and odd characters refused)');

  // ---- MCP agents say their model once; everything they touch is stamped ----
  const store = new Store(vault);
  const mcp = createMcp(store);
  const s = { transport: 'connector', local: false };
  const rpc = async (method, params) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method, params }, s)).result;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT' } });
  const list = await rpc('tools/list', {});
  const props = (n) => list.tools.find((t) => t.name === n).inputSchema.properties;
  assert.ok(props('live_update').model && props('task_update').model && props('cortex_start').model, 'model offered on the main tools');
  assert.ok(!props('memory_search').model, 'not on every tool (token cost)');
  const call = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).content[0].text);
  const start = await call('cortex_start', {});
  assert.ok(/not reported/.test(start.your_model), 'cortex_start asks for the model while unknown');
  await call('live_update', { step: 'starting', model: 'gpt-6.2' });
  assert.equal(s.model, 'gpt-6.2');
  const t = await call('task_create', { title: 'Write release notes' });
  assert.equal(store.get(t.id).meta.model, 'gpt-6.2'); assert.equal(store.get(t.id).meta.model_agent, 'ChatGPT');
  await call('task_update', { id: t.id, status: 'doing', append_note: 'started' });
  assert.ok(/ChatGPT \(gpt-6\.2\)/.test(store.get(t.id).body), 'progress notes name the model');
  await call('activity_log', { summary: 'did a thing' });
  const act = fs.readFileSync(path.join(vault, '.cortex', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a.summary === 'did a thing').pop();
  assert.equal(act.model, 'gpt-6.2');
  assert.equal(sessions.get(vault, s.id).model, 'gpt-6.2', 'live card shows the model');
  assert.equal((await call('cortex_start', {})).your_model, 'gpt-6.2');
  ok('an MCP agent states its model once → its tasks, notes, activity and live card all record it');

  // ---- Claude Code: model from the session log, and tasks it touches get stamped ----
  const tr = path.join(tmp, 't.jsonl');
  fs.writeFileSync(tr, [JSON.stringify({ type: 'user', message: {} }), JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', usage: {} } })].join('\n'));
  assert.equal(models.claudeModelFromTranscript(tr), 'claude-sonnet-5-5');
  const t2 = store.create('task', { title: 'Fix login' });
  await hooks.runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: tmp, prompt: 'fix the login', transcript_path: tr }, vault);
  assert.equal(sessions.get(vault, 'cc-cc1').model, 'claude-sonnet-5-5', 'model known from the first prompt');
  await hooks.runHook({ hook_event_name: 'PostToolUse', session_id: 'cc1', cwd: tmp, transcript_path: tr, tool_name: 'mcp__claude_ai_cortex__task_update', tool_input: { id: t2.id, status: 'doing' }, tool_response: [{ type: 'text', text: JSON.stringify({ id: t2.id, status: 'doing' }) }] }, vault);
  store.scan(false);
  assert.equal(store.get(t2.id).meta.model, 'claude-sonnet-5-5'); assert.equal(store.get(t2.id).meta.model_agent, 'claude-code');
  await hooks.runHook({ hook_event_name: 'PostToolUse', session_id: 'cc1', cwd: tmp, transcript_path: tr, tool_name: 'mcp__300816c3-9096__task_create', tool_input: { title: 'x' }, tool_response: '{"id":"tasks/zzz-not-there"}' }, vault);
  ok('Claude Code: model read from its session log; tasks it creates/updates through any Cortex connection are stamped');

  // ---- Codex: model from its own log; default from config ----
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '20');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-2026-11-20T01-00-00-abc.jsonl'), '{"type":"turn_context","payload":{"model":"gpt-6.2-sol"}}\n');
  assert.equal(models.codexModelSince(Date.now() - 60000, home), 'gpt-6.2-sol');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6.2"\n');
  assert.equal(models.codexDefaultModel(home), 'gpt-6.2');
  ok('Codex: the real model is read from its session log (and its configured default up front)');

  // ---- runs started from Cortex stamp their task ----
  const { AgentRunner } = require(path.join(ROOT, 'src', 'agents.js'));
  const runner = new AgentRunner(store);
  const t3 = store.create('task', { title: 'Run me' });
  const rec = { id: 'run-test1', task: t3.id, agent: 'codex', tool: 'codex', started: Date.now() - 1000 };
  sessions.upsert(vault, rec.id, { agent: 'codex', status: 'working' });
  runner.stampModel(rec, 'gpt-6.2-sol');
  assert.equal(store.get(t3.id).meta.model, 'gpt-6.2-sol'); assert.equal(sessions.get(vault, rec.id).model, 'gpt-6.2-sol');
  ok('runs started from Cortex record their real model on the task and the live card');

  console.log('\nAll model reporting checks passed.');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
