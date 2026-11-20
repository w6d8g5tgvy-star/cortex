'use strict';
// Token cost: Cortex keeps what it puts into an AI's context small without hiding anything.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-lean-'));
process.env.USERPROFILE = path.join(tmp, 'home'); process.env.HOME = process.env.USERPROFILE;
const vault = path.join(tmp, 'vault');
const ok = (m) => console.log('  ✓ ' + m);

(async () => {
  console.log('Lean context');
  const { Store } = require(path.join(ROOT, 'src', 'store.js'));
  const { createMcp } = require(path.join(ROOT, 'src', 'mcp.js'));
  const hooks = require(path.join(ROOT, 'src', 'claude-hooks.js'));
  const store = new Store(vault);
  store.create('project', { title: 'Shop', folder: path.join(tmp, 'shop') });
  store.create('note', { title: 'Checkout uses Stripe', project: 'shop', body: 'The checkout page talks to Stripe in test mode; keys live in .env.local.' });
  store.create('note', { title: 'Agent journal: shop', project: 'shop', agent_journal: 'shop', body: '- 10:00 · claude-code · did things\n'.repeat(50) });
  fs.mkdirSync(path.join(tmp, 'shop'), { recursive: true });

  // cortex_start: compact JSON, short rules instead of the full instructions, journals as pointers only
  const mcp = createMcp(store);
  const session = { transport: 'http', local: true, agent: 'lean-test' };
  const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cortex_start', arguments: { project: 'shop' } } }, session);
  const text = r.result.content[0].text;
  assert.ok(!/\n\s{2}"/.test(text), 'tool replies are compact JSON');
  const s = JSON.parse(text);
  assert.ok(s.rules && !s.instructions, 'short rules, not the full server instructions');
  assert.ok(s.project_memories.some((n) => n.title === 'Checkout uses Stripe'), 'project memories still listed');
  assert.ok(!s.project_memories.some((n) => /journal/i.test(n.title)), 'journal not inlined');
  assert.ok(s.journals.includes('notes/shop/agent-journal-shop') || s.journals.some((j) => /journal/.test(j)), 'journal available by id');
  assert.ok(Array.isArray(s.commands_from_user), 'commands are always reported');
  ok(`cortex_start is compact (${Math.round(text.length / 4)} tokens) and still lists memories, tasks, commands and journals`);

  // Claude Code brief replaces cortex_start; a resumed session gets a one-line reminder
  const start = await hooks.runHook({ hook_event_name: 'SessionStart', session_id: 'l1', cwd: path.join(tmp, 'shop'), source: 'startup' }, vault);
  const full = start.hookSpecificOutput.additionalContext;
  assert.ok(/Checkout uses Stripe/.test(full) && /do not call them again/.test(full));
  const resumed = await hooks.runHook({ hook_event_name: 'SessionStart', session_id: 'l1', cwd: path.join(tmp, 'shop'), source: 'resume' }, vault);
  assert.ok(resumed.hookSpecificOutput.additionalContext.length < 300, 'resume reminder is short');
  const compact = await hooks.runHook({ hook_event_name: 'SessionStart', session_id: 'l1', cwd: path.join(tmp, 'shop'), source: 'compact' }, vault);
  assert.ok(/Checkout uses Stripe/.test(compact.hookSpecificOutput.additionalContext), 'after compaction the full brief comes back');
  ok('session brief replaces cortex_start; resume gets a short reminder; compaction gets the full brief again');

  // recall: nothing for trivial prompts; a note is sent once per session unless it changes
  const ask = (prompt) => hooks.runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'l1', cwd: path.join(tmp, 'shop'), prompt }, vault);
  const ctx = (x) => (x && x.hookSpecificOutput && x.hookSpecificOutput.additionalContext) || '';
  assert.equal(ctx(await ask('continue')), '');
  assert.equal(ctx(await ask('yes please')), '');
  assert.ok(/Checkout uses Stripe/.test(ctx(await ask('how does the stripe checkout work?'))), 'first time: recalled');
  assert.ok(!/Checkout uses Stripe/.test(ctx(await ask('stripe checkout keys again?'))), 'second time: not repeated');
  store.update('notes/shop/checkout-uses-stripe', { append: 'Live keys are in the vault, not .env.' });
  assert.ok(/Checkout uses Stripe/.test(ctx(await ask('stripe checkout live keys?'))), 'changed note: recalled again');
  ok('recall skips trivial prompts, does not repeat a note, and re-sends it after it changes');

  console.log('\nAll lean context checks passed.');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
