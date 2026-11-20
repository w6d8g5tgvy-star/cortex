'use strict';
// Fetcher readiness (setup panel), Codex as the checker, and the new speech fixes. No network, no AI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../src/setup');
const reader = require('../src/reader');
const { Fetcher } = require('../src/fetcher');
const { Store } = require('../src/store');

let n = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('  ✓ ' + name); });

(async () => {
  console.log('Setup / Codex checks');
  await ok('every item has a reason and an install command for this system', () => {
    for (const [k, it] of Object.entries(setup.ITEMS)) {
      assert.ok(it.why && it.label, k);
      const cmd = setup.installCommand(k);
      assert.ok(cmd && cmd.length > 5, k + ' command');
      if (process.platform === 'win32' && it.winget) assert.match(cmd, new RegExp(`winget install --id ${it.winget.replace('.', '\\.')} -e`));
    }
    assert.strictEqual(setup.installCommand('nope'), null);
  });
  await ok('only known items can be installed, and the hand-installed ones say how', () => {
    assert.throws(() => setup.install('rm -rf'), /by hand|unknown/);
    assert.throws(() => setup.install('claude'), /by hand/);
  });
  await ok('check() reports each item and whether Fetcher is ready (fake runner)', async () => {
    const fake = { available: async () => ({ claude: { path: null }, codex: { path: null } }) };
    const s = await setup.check(fake);
    assert.ok(Array.isArray(s.items) && s.items.length === Object.keys(setup.ITEMS).length);
    const claude = s.items.find((i) => i.key === 'claude');
    assert.strictEqual(claude.ok, false);
    assert.strictEqual(s.ready, false, 'not ready without Claude Code');
    assert.ok(!/[\w.]+@[\w-]+\.\w+|"email"|orgId/.test(JSON.stringify(s)), 'no account details in the status');
  });
  await ok('speech fixes: misheard ChatGPT, CLAUDE.md and AGENTS.md', () => {
    assert.strictEqual(reader.correctTerms('so Chachi PT said', [], 'LLMs like ChatGPT').text, 'so ChatGPT said');
    assert.strictEqual(reader.correctTerms('edit your cloud md file', [], 'Claude Code tips').text, 'edit your CLAUDE.md file');
    assert.strictEqual(reader.correctTerms('put it in agents dot md', [], 'Codex').text, 'put it in AGENTS.md');
    assert.strictEqual(reader.correctTerms('the cloud md file', [], 'AWS storage').text, 'the cloud md file', 'no Claude context, no change');
  });
  await ok('Codex as the checker: a job records tool codex and its own model, not the Claude usage model', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-setup-'));
    const store = new Store(vault);
    require('../src/settings').update(vault, { fetcher: { reviewer: 'codex', codexModel: 'gpt-test' } });
    const fx = new Fetcher({ store, runner: {}, broadcast: () => {} });
    const job = fx.create({ topic: 'writing AGENTS.md files', usage: 'low' }, { start: false });
    const full = fx.get(job.id);
    assert.strictEqual(full.tool, 'codex');
    assert.strictEqual(full.model, 'gpt-test');
    require('../src/settings').update(vault, { fetcher: { reviewer: 'claude', codexModel: '' } });
    const j2 = fx.get(fx.create({ topic: 'writing CLAUDE.md files', usage: 'low' }, { start: false }).id);
    assert.strictEqual(j2.tool, 'claude');
    assert.strictEqual(j2.model, 'haiku');
    fs.rmSync(vault, { recursive: true, force: true });
  });
  console.log(`\nAll ${n} setup checks passed.`);
})().catch((e) => { console.error('✗', e); process.exit(1); });
