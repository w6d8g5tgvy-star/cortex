'use strict';
// Fetcher 3: long videos read in full (skim), techniques written as general rules and tried out on real tasks before
// they are taught, and agents' feedback on whether a technique helped (ones that keep failing are dropped). No AI, no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const F = require(path.join(ROOT, 'src', 'fetcher.js'));
const { Store } = require(path.join(ROOT, 'src', 'store.js'));
const { createMcp } = require(path.join(ROOT, 'src', 'mcp.js'));

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };
const ts = (s) => `[${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}]`;

(async () => {
  console.log('Fetcher 3 checks');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-fx3-'));
  const store = new Store(path.join(tmp, 'vault'));

  // ---- 1. long videos ----
  // 2 hours of talk; the one usable idea (at 1:30:00) never uses the request's words
  const filler = (s) => `${ts(s)} and so we talked about the weather and other stuff for a while and then some more of it again`;
  const lines = [];
  for (let s = 0; s < 7200; s += 20) lines.push(s === 5400 ? `${ts(s)} the trick is to give the assistant a one page map of the repository so it stops opening every file` : filler(s));
  const long = lines.join('\n');
  const plain = F.excerpt(long, ['context window', 're-reading'], 3000);
  assert.ok(!/one page map/.test(plain), 'keyword matching alone misses the idea');
  const steered = F.excerpt(long, ['context window', 're-reading'], 3000, [], [{ at: '90:00', idea: 'give it a map of the repo', strength: 5 }]);
  assert.ok(/one page map/.test(steered), 'a skim moment pulls that part into the excerpt');
  ok('long video: an idea phrased in other words is missed by keywords but found through the skim');

  const chapters = [{ start: 0, title: 'Context window basics' }, { start: 2400, title: 'Part two' }, { start: 4800, title: 'Part three' }];
  const spread = F.excerpt(long.replace(/weather/g, 'context window'), ['context window'], 4000, chapters);
  const times = [...spread.matchAll(/\[(\d+):(\d\d)\]/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  assert.ok(times.some((t) => t >= 2400 && t < 4800) && times.some((t) => t >= 4800), 'excerpt reaches every chapter, not just the first');
  ok('excerpt is spread across the chapters instead of filling up from one part');

  const parts = F.transcriptParts(long);
  assert.ok(parts.length >= 2 && parts.length <= 8 && parts.join('') === long, `split into ${parts.length} parts, nothing lost`);
  const asked = [];
  const skimAsk = async (instr, input) => { asked.push(input); const hit = /one page map/.test(input); return { text: JSON.stringify({ moments: hit ? [{ at: '90:00', idea: 'give the assistant a one page repo map', strength: 5 }] : [] }), usage: { input: 1000, output: 20 }, cost: 0.001, model: 'claude-haiku-5-5' }; };
  const sk = await F.skimTranscript(skimAsk, { topic: 'agents re-read files', plan: { goal: 'stop re-reading' } }, { title: 'Long talk', transcript: long, glossary: [] });
  assert.equal(asked.length, parts.length, 'every part is skimmed');
  assert.ok(asked.every((i) => /Research goal: stop re-reading/.test(i)));
  assert.equal(sk.moments.length, 1); assert.equal(sk.moments[0].at, '90:00');
  ok(`skim reads all ${parts.length} parts of a 2-hour transcript with the cheap model and returns the moments with usable ideas`);

  // full run: the long video is skimmed, the checker sees the map and the idea; Low usage never skims
  const reviewInputs = [];
  const mkDeps = (extra = {}) => ({
    planAsk: async () => ({ text: JSON.stringify({ goal: 'stop re-reading', vocabulary: ['context window'], queries: ['q1'], must_have: ['steps'] }), usage: { input: 10, output: 10 }, cost: 0.001, model: 'claude-haiku-5-5' }),
    skimAsk,
    search: async () => [{ id: 'L1', title: 'Two hour talk on context window', channel: 'c', duration: 7200, views: 5000 }],
    read: async (id) => ({ id, title: 'Two hour talk on context window', duration: 7200, transcript: long, transcriptSource: 'auto-captions', chapters: [], glossary: [], comments: [], links: [], frames: [], notes: [] }),
    ask: async (instr, input) => {
      if (/tryout step/.test(instr)) return { text: JSON.stringify({ techniques: [{ index: 0, keep: true, reason: 'concrete', name: 'Keep a repo map', when: 'a task needs many files', do: 'Write a one-page map of the repo and read it first', why: 'fewer reads', task: 'Fix login bug', steps: 'Read the map, open only auth files' }] }), usage: { input: 500, output: 100 }, cost: 0.002, model: 'claude-sonnet-5-5' };
      reviewInputs.push(input);
      return { text: JSON.stringify({ summary: 's', techniques: [{ name: 'Repo map', when: 'When A repository is big', do: 'map it', why: 'w', evidence: '90:00 transcript' }], impact: 4, applicability: 4, confidence: 4, effort: 1, risk: 1, meets_request: true, reasoning: 'r' }), usage: { input: 900, output: 90 }, cost: 0.01, model: 'claude-sonnet-5-5' };
    },
    related: null, retryMs: 1, ...extra,
  });
  const fx = new F.Fetcher({ store, runner: null, deps: mkDeps() });
  const wait = async (f, id) => { let d; for (let i = 0; i < 400; i++) { d = f.get(id); if (['done', 'error'].includes(d.status)) break; await new Promise((r) => setTimeout(r, 20)); } return d; };
  const j1 = await wait(fx, fx.create({ topic: 'agents keep re-reading files', usage: 'medium', related: false, depth: 'quick' }).id);
  assert.equal(j1.status, 'done', j1.step);
  const v1 = j1.videos.find((v) => v.id === 'L1');
  assert.ok(v1.skim && v1.skim.moments === 1, JSON.stringify(v1.skim));
  assert.ok(/skim found across the WHOLE video/.test(reviewInputs[0]) && /one page map/.test(reviewInputs[0]), 'checker sees the skim map and the passage');
  assert.ok(/% of the whole/.test(reviewInputs[0]), 'checker is told how much of the transcript it sees');
  assert.equal(j1.models.skimmer, 'claude-haiku-5-5');
  ok('full run: a 2-hour video is skimmed (cheap model), and the checker gets the map plus the passage it points to');

  const before = reviewInputs.length; asked.length = 0;
  const j2 = await wait(fx, fx.create({ topic: 'agents keep re-reading files again', usage: 'low', related: false }).id);
  assert.equal(j2.status, 'done', j2.step);
  assert.equal(asked.length, 0, 'Low usage never skims');
  assert.ok(reviewInputs.length > before);
  ok('Low usage skips the skim (keyword + chapter-spread excerpt only)');

  // ---- 2 + 3. general rules, tryout before teaching ----
  const lesson1 = store.get(j1.lesson.id);
  assert.ok(/Keep a repo map/.test(lesson1.body), 'the tryout\'s general wording is what gets taught');
  assert.ok(/Example \(tried on "Fix login bug"\)/.test(lesson1.body), 'a worked example on a real task');
  assert.ok(/the ones with an Example were also tried out on a real task/.test(lesson1.body) && /lesson_feedback/.test(lesson1.body));
  assert.equal(j1.tryout.kept, 1);
  ok('tryout: a kept technique is reworded as a general rule and shows how it was applied to a real task');

  assert.equal(F.whenText('When A repository uses uv'), 'a repository uses uv');
  assert.equal(F.whenText('CLAUDE.md is long.'), 'CLAUDE.md is long');
  assert.ok(F.takeaways([{ name: 'X', when: 'When An agent edits AGENTS.md', do: 'd', sources: [] }])[0].includes('when an agent edits AGENTS.md →'));
  ok('"when" reads naturally ("when a repository…"), names and acronyms keep their capitals');

  const job = { topic: 'drop test', threshold: 60, models: {}, plan: {}, videos: [
    { id: 'd1', title: 'D1', score: 80, verdict: 'worth it', review: { techniques: [
      { name: 'Use the Lucas function', when: 'w', do: 'Check the lucas() function in utils.py', why: 'y', evidence: '1:00' },
      { name: 'Short rules file', when: 'w', do: 'Keep it short', why: 'y', evidence: '2:00' },
    ] } }] };
  const cands = [];
  job.videos[0].review.techniques.forEach((t, k) => cands.push({ v: job.videos[0], k, t }));
  const input = F.tryoutInput(store, job, cands);
  assert.ok(/Real tasks on the user's board/.test(input) && /\[0\] Use the Lucas function/.test(input) && /Techniques agents already know/.test(input) && /Keep a repo map/.test(input), 'tryout sees real tasks and what agents already know');
  const res = F.applyTryout(cands, JSON.stringify({ techniques: [
    { index: 0, keep: false, reason: 'only makes sense in the demo project' },
    { index: 1, keep: true, name: 'Keep rules files short', when: 'a rules file grows past a page', do: 'Move details into linked files', why: 'less to read', task: 'a typical task', steps: 'Trim CLAUDE.md' },
  ] }));
  assert.deepEqual([res.kept, res.dropped], [1, 1]);
  const taught = F.teach(store, job);
  const body = store.get(taught.id).body;
  assert.ok(!/Lucas/.test(body) && /Keep rules files short/.test(body), 'demo-only technique dropped, general one taught');
  ok('tryout drops demo-only or unfollowable techniques; they never reach the lesson');

  job.videos[0].taught = true;
  const forced = F.teach(store, job);
  assert.ok(/Lucas/.test(store.get(forced.id).body), 'you can still teach a dropped technique yourself');
  ok('a technique the tryout dropped can still be taught when you pick the video yourself');

  // the reply numbers from 1 and adds an unknown row: answers still land on the right technique, by name
  const c2 = [{ v: job.videos[0], k: 0, t: { name: 'Alpha rule', when: 'w', do: 'd', evidence: 'e' } }, { v: job.videos[0], k: 1, t: { name: 'Beta check', when: 'w', do: 'd', evidence: 'e' } }];
  const r2 = F.applyTryout(c2, 'Here you go: {"techniques":[{"index":1,"original":"Alpha rule","keep":false,"reason":"generic"},{"index":2,"original":"Beta check","keep":true,"name":"Beta check","task":"t","steps":"s"},{"index":3,"original":"Gamma","keep":true}]} done');
  assert.ok(c2[0].t.dropped === 'generic' && c2[1].t.tryout && r2.missing === 0, JSON.stringify(r2));
  ok('tryout answers are matched by name too (a reply that counts from 1 cannot mix techniques up)');

  // the lesson this run adds to is not "already known": finding its techniques again confirms them
  const sameTopic = { topic: 'agents keep re-reading files', plan: { topic: j1.plan.topic }, videos: [] };
  assert.ok(!/Keep a repo map/.test(F.tryoutInput(store, sameTopic, [])), 'own lesson excluded');
  assert.ok(/Keep a repo map/.test(F.tryoutInput(store, { topic: 'something else entirely', plan: {}, videos: [] }, [])), 'other lessons included');
  ok('tryout compares with OTHER lessons only, so re-finding a technique confirms it instead of dropping it');

  // a cut-off checker reply is asked again once
  let tries = 0;
  const fxR = new F.Fetcher({ store, runner: null, deps: mkDeps({ skimAsk: null, ask: async (instr) => {
    if (/tryout step/.test(instr)) return { text: '{"techniques":[]}', cost: 0 };
    tries++;
    return tries === 1 ? { text: '{"summary":"cut off mid', cost: 0.01 } : { text: JSON.stringify({ summary: 's', techniques: [], impact: 2, applicability: 2, confidence: 3, effort: 2, risk: 1, meets_request: true, reasoning: 'r' }), cost: 0.01 };
  } }) });
  const jr = await wait(fxR, fxR.create({ topic: 'retry check context window', usage: 'low', related: false }).id);
  const vr = jr.videos.find((v) => v.id === 'L1');
  assert.ok(vr.review && vr.retried && !vr.error && tries === 2, JSON.stringify({ tries, err: vr.error }));
  assert.ok(F.parseReview('I checked {frame 3}.\n```json\n{"summary":"x } y","techniques":[]}\n```').summary === 'x } y');
  ok('a cut-off or messy checker reply is parsed if possible, otherwise asked again once');

  // ---- 4. feedback ----
  const mcp = createMcp(store);
  const sess = { transport: 'http', local: true, agent: 'claude-code' };
  const call = async (name, args) => { const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, sess); const t = r.result.content[0].text; if (r.result.isError) throw new Error(t); return JSON.parse(t); };
  const title = lesson1.title;
  const fb1 = await call('lesson_feedback', { lesson: title, technique: 'keep a repo map', result: 'helped', note: 'cut file reads by half', model: 'claude-opus-5-5' });
  assert.equal(fb1.technique, 'Keep a repo map'); assert.equal(fb1.track_record.helped, 1);
  const after = store.get(lesson1.id);
  assert.ok(/Track record:\*\* used 1× · helped 1/.test(after.body) && /helped 1×/.test(after.body));
  const act = store.recentActivity({ limit: 5 }).find((a) => a.action === 'lesson.feedback');
  assert.ok(act && act.model === 'claude-opus-5-5' && /cut file reads/.test(act.summary));
  ok('lesson_feedback (MCP): "helped" is counted, shown in the lesson, and logged with the agent\'s model');

  const L2 = store.get(taught.id).title;
  for (let i = 0; i < F.FADE_AFTER; i++) await call('lesson_feedback', { lesson: L2, technique: 'Use the Lucas function', result: 'didnt_help', note: 'not relevant' });
  const faded = store.get(taught.id);
  assert.ok(!/Lucas/.test(faded.body), 'dropped after repeated "didn\'t help"');
  assert.ok(/Lucas/.test(faded.meta.fetcher_faded));
  job.videos[0].taught = false; job.videos[0].review.techniques[0].dropped = undefined;
  F.teach(store, job);
  assert.ok(!/Lucas/.test(store.get(taught.id).body), 'a later run does not bring it back');
  ok(`a technique that didn't help ${F.FADE_AFTER} times (and never helped) is dropped, and later runs don't re-add it`);

  await assert.rejects(call('lesson_feedback', { lesson: 'no such lesson at all', technique: 'x', result: 'helped' }), /No lesson matches/);
  await assert.rejects(call('lesson_feedback', { lesson: title, technique: 'x', result: 'great' }), /result must be/);
  ok('clear errors for an unknown lesson or result');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${n} Fetcher 3 checks passed.`);
})().catch((e) => { console.error('✗', e); process.exit(1); });
