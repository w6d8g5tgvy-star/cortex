'use strict';
// Experience digest: parses agent journals and finds hot files, fail → fix pairs and trouble words, for free.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const journal = require('../src/journal');
const exp = require('../src/experience');
const brief = require('../src/brief');

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-exp-'));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const store = new Store(vault);
store.create('project', { title: 'Shop' });

const S = (o) => journal.session(vault, 'shop', { agent: 'claude-code', commands: 2, savedMemory: false, ...o });
S({ title: 'Add Apple Pay to checkout', files: ['checkout.tsx', 'pay.ts'], outcome: 'Tests failed: ApplePay is not defined in the test environment.' });
S({ title: 'Fix the Apple Pay checkout tests', files: ['checkout.tsx', 'setupTests.ts'], outcome: 'Fixed by mocking window.ApplePaySession in setupTests.ts; all checkout tests pass.', savedMemory: true });
S({ title: 'Update cart totals', files: ['cart.ts', 'checkout.tsx'], outcome: 'Done. Totals include tax now.' });
S({ title: 'Deploy to staging', status: 'error', files: ['deploy.yml'], outcome: 'Deploy failed: permission denied for the staging bucket.' });
S({ title: 'Deploy to staging again', files: ['deploy.yml'], outcome: 'Deployed after adding the storage.objectAdmin role to the CI service account.', savedMemory: true });
journal.line(vault, 'shop', 'codex', 'Created task "Refunds"');

const text = fs.readFileSync(journal.fileFor(vault, 'shop'), 'utf8');
const parsed = exp.parse(text);
assert.equal(parsed.sessions.length, 5);
assert.equal(parsed.actions.length, 1);
assert.deepEqual(parsed.sessions[0].files, ['checkout.tsx', 'pay.ts']);
assert.equal(parsed.sessions[0].status, 'trouble'); // "finished" but the outcome reports a failure
assert.equal(parsed.sessions[1].status, 'ok');      // "fixed … pass" is a success
assert.equal(parsed.sessions[3].status, 'fail');
ok('parses journal sessions, files, saves and real outcomes (a "finished" run that failed counts as trouble)');

const d = exp.digest(store, 'shop');
assert.equal(d.sessions, 5);
assert.equal(d.trouble, 2);
assert.equal(d.hot[0][0], 'checkout.tsx');
assert.equal(d.hot[0][1], 3);
assert.equal(d.pairs.length, 2);
assert.ok(d.pairs[0].fixed.outcome.includes('mocking window.ApplePaySession'));
assert.ok(d.pairs[1].fixed.outcome.includes('storage.objectAdmin'));
assert.equal(d.saved, 2);
ok('finds hot files, fail → fix pairs (by shared files) and the save rate');

const r1 = exp.writeDigest(store, 'shop');
assert.ok(r1.id.startsWith('notes/shop/'));
const note = store.get(r1.id);
assert.ok(note.body.includes('Fail → fix pairs') && note.body.includes('`checkout.tsx`: changed in 3 sessions'));
const r2 = exp.writeDigest(store, 'shop');
assert.equal(r2.id, r1.id);
assert.equal(r2.changed, false);
assert.equal(store.list('note', { project: 'shop' }).filter((n) => n.meta.experience_digest).length, 1);
ok('writes one digest memory in the project folder and only updates it when something changed');

const b = brief.buildBrief(store, { project: 'shop' }).text;
assert.ok(b.includes('Learned from earlier sessions') && b.includes('checkout.tsx') && b.includes('storage.objectAdmin'));
assert.ok(exp.briefLines(d).join('\n').length < 700);
ok('agents get a short "learned from earlier sessions" section in the project brief');

assert.equal(exp.digest(store, 'nope').sessions, 0);
assert.ok(exp.markdown(exp.digest(store, 'nope'), 'Nope').includes('No agent sessions'));
ok('projects without a journal give an empty digest instead of failing');

fs.rmSync(vault, { recursive: true, force: true });
console.log(`All ${passed} experience checks passed.`);
process.exit(0);
