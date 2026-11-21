'use strict';
// Secrets never reach the agent journal or the activity log, even when an agent's reply contains them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact, _resetCache } = require('../src/redact');
const { Store } = require('../src/store');
const journal = require('../src/journal');

let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// patterns
const r = (s) => redact(s);
assert.strictEqual(r('open https://home.example.ts.net/?token=AbC123xyz789QWE#/live now'), 'open https://home.example.ts.net/?token=<redacted>#/live now');
assert.strictEqual(r('link http://127.0.0.1:7777/mcp/k3y_SECRET-value-123 ok'), 'link http://127.0.0.1:7777/mcp/<secret> ok');
assert.ok(!r('key sk-ant-api03-abcdefghijklmnopqrstuvwx').includes('abcdefghijkl'));
assert.ok(!r('Authorization: Bearer abcdefghijklmnop1234').includes('abcdefghijklmnop1234'));
assert.ok(!r('ghp_' + 'a'.repeat(36)).includes('aaaaaaaaaa'));
assert.strictEqual(r('normal text with a token word and /mcp/ path'), 'normal text with a token word and /mcp/ path');
assert.strictEqual(r('see https://example.com/page?id=5&sort=new'), 'see https://example.com/page?id=5&sort=new');
ok('redacts URL tokens, connector links, API keys and bearer tokens; leaves normal text and URLs alone');

// the vault's own secrets, anywhere in the text, and through the journal + activity log
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-redact-'));
fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });
const PAIR = 'pairTok3nVALUE9876'; const CONN = 'connSecretVALUE_5432';
fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ remote: { token: PAIR }, connector: { token: CONN } }));
_resetCache();
assert.strictEqual(redact(`token is ${PAIR} and ${CONN}`, vault), 'token is <redacted> and <redacted>');
const store = new Store(vault);
store.create('project', { title: 'Shop' });
journal.session(vault, 'shop', { agent: 'claude-code', title: 'Open Cortex on my phone', outcome: `Tap https://pc.example.ts.net/?token=${PAIR}#/live (secret ${CONN})`, status: 'done' });
store.log({ agent: 'codex', action: 'note', project: 'shop', summary: `phone link https://pc.example.ts.net/?token=${PAIR}` });
const jtext = fs.readFileSync(path.join(vault, 'notes', 'shop', 'agent-journal.md'), 'utf8');
const atext = fs.readFileSync(store.actFile, 'utf8');
for (const t of [PAIR, CONN]) { assert.ok(!jtext.includes(t), 'journal leaked ' + t); assert.ok(!atext.includes(t), 'activity leaked ' + t); }
assert.ok(jtext.includes('?token=<redacted>#/live') && jtext.includes('Open Cortex on my phone'));
ok("the agent journal and activity log never store the vault's pairing token or connector secret");

fs.rmSync(vault, { recursive: true, force: true });
console.log(`All ${passed} redaction checks passed.`);
process.exit(0);
