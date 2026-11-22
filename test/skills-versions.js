'use strict';
// Skill evolution (2.2 #8): versions, candidates that must earn their place, feedback, rollback.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const sv = require('../src/skill-versions');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const v = fs.mkdtempSync(path.join(os.tmpdir(), 'skv-')); const st = new Store(v);
const mcp = require('../src/mcp').createMcp(st); const tool = (n) => mcp.tools.find((t) => t.name === n);

const c = tool('skill_save').run({ title: 'Write tests first', description: 'For new features', instructions: 'Write a failing test, then make it pass.' }, { agent: 'claude-code' });
assert.equal(c.version, 1); assert.equal(c.status, 'default');
const cand = tool('skill_save').run({ title: 'Write tests first', description: 'For new features', instructions: 'Write a failing test, run it to see it fail, then make it pass. Commit after each green test.', note: 'adds the run-it-red step', sources: ['https://example.com/tdd'] }, { agent: 'codex' });
assert.equal(cand.status, 'candidate');
assert.ok(st.get('skills/write-tests-first').body.startsWith('Write a failing test, then'), 'an agent edit does not replace the default yet');
const g1 = tool('skill_get').run({ name: 'write-tests-first' }, { agent: 'a' }); const g2 = tool('skill_get').run({ name: 'write-tests-first' }, { agent: 'a' });
assert.ok([g1, g2].some((g) => /version 2 \(candidate\)/.test(g)) && [g1, g2].some((g) => /version 1 \(default\)/.test(g)), 'both versions get used, so both collect evidence');
ok('agents\' edits become candidate versions; uses alternate between default and candidate');

tool('skill_feedback').run({ name: 'write-tests-first', version: 1, result: 'partly' }, { agent: 'a' });
tool('skill_feedback').run({ name: 'write-tests-first', version: 1, result: 'didnt_help' }, { agent: 'a' });
let r;
for (let i = 0; i < 2; i++) { r = tool('skill_feedback').run({ name: 'write-tests-first', version: 2, result: 'helped' }, { agent: 'b', model: 'claude-haiku-5-5' }); assert.equal(r.promoted, null, 'not before 3 reports'); }
r = tool('skill_feedback').run({ name: 'write-tests-first', version: 2, result: 'helped' }, { agent: 'b', model: 'claude-haiku-5-5' });
assert.equal(r.promoted, 2);
assert.ok(st.get('skills/write-tests-first').body.includes('run it to see it fail'));
const L = tool('skill_versions').run({ name: 'write-tests-first' });
assert.equal(L.current, 2); assert.equal(L.versions.find((x) => x.version === 1).status, 'previous');
assert.ok(L.versions.find((x) => x.version === 2).sources.includes('https://example.com/tdd'));
ok('a candidate replaces the default only after 3 reports showing it helps at least as much; history keeps both');

tool('skill_save').run({ title: 'Write tests first', description: 'For new features', instructions: 'Just write code.' }, { agent: 'codex' });
for (let i = 0; i < 6; i++) tool('skill_feedback').run({ name: 'write-tests-first', version: 3, result: 'didnt_help' }, { agent: 'b' });
assert.equal(tool('skill_versions').run({ name: 'write-tests-first' }).versions.find((x) => x.version === 3).status, 'rejected');
assert.ok(st.get('skills/write-tests-first').body.includes('run it to see it fail'), 'a worse candidate never becomes default');
sv.setDefault(st, 'write-tests-first', 1);
assert.ok(st.get('skills/write-tests-first').body.startsWith('Write a failing test, then'));
const mine = sv.saveVersion(st, { title: 'Write tests first', description: 'x', instructions: 'My own wording.', by: 'you' });
assert.equal(mine.status, 'default', 'the user\'s own edits apply directly, as before');
ok('worse candidates are rejected; any version can be restored; the user\'s own edits apply directly');
fs.rmSync(v, { recursive: true, force: true });
console.log(`All ${passed} skill version checks passed.`);
