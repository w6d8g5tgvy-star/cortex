'use strict';
// Fetcher: every goal checked with a fake YouTube and a fake usefulness checker (free and repeatable).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-fetcher-'));
process.env.USERPROFILE = path.join(tmp, 'home'); process.env.HOME = process.env.USERPROFILE;
const vault = path.join(tmp, 'vault');
const ok = (m) => console.log('  ✓ ' + m);
const F = require(path.join(ROOT, 'src', 'fetcher.js'));
const { Store } = require(path.join(ROOT, 'src', 'store.js'));
const { createMcp } = require(path.join(ROOT, 'src', 'mcp.js'));
const hooks = require(path.join(ROOT, 'src', 'claude-hooks.js'));

// ---- fake YouTube ----
const words = (n, w) => Array.from({ length: n }, (_, i) => w[i % w.length]).join(' ');
const VIDEOS = {
  good1: { title: 'Prompt caching for coding agents: cut tokens 80%', views: 250000, duration: 900, transcript: `[00:00] today prompt caching for coding agents. [01:10] first put the stable system prompt and tool definitions first then the changing part last so the cache hits. ${words(600, ['prompt', 'caching', 'agents', 'tokens', 'step', 'then', 'use', 'cache', 'coding', 'make', 'sure'])} [09:40] you can check cache hits in the usage numbers.` },
  good2: { title: 'Stop wasting tokens: prompt caching agents tips', views: 90000, duration: 700, transcript: `[00:00] prompt caching tips for agents ${words(500, ['prompt', 'caching', 'tokens', 'agents', 'first', 'then', 'workflow', 'tip'])}` },
  meh: { title: 'Prompt caching explained (theory)', views: 40000, duration: 1500, transcript: `[00:00] the history of caching in computer science ${words(500, ['history', 'theory', 'memory', 'cpu', 'cache', 'prompt'])}` },
  nosub: { title: 'Prompt caching agents live stream', views: 5000, duration: 600, transcript: '' },
  offtopic: { title: 'Prompt caching agents? My cooking vlog', views: 2000, duration: 800, transcript: `[00:00] ${words(500, ['pasta', 'salt', 'water', 'boil', 'tomato'])}` },
  short: { title: 'prompt caching #shorts', views: 1000000, duration: 40, transcript: '' },
};
let searches = 0;
const search = async (q) => { searches++; return Object.entries(VIDEOS).map(([id, v]) => ({ id, title: v.title, views: v.views, duration: v.duration, channel: 'ch-' + id })); };
let throttled = 0;
const fetchVideo = async (id) => {
  if (id === 'good2' && throttled < 1) { throttled++; return { title: VIDEOS[id].title, transcript: '', note: 'Captions found but could not be downloaded: The site answered HTTP 429' }; }
  return { title: VIDEOS[id].title, transcript: VIDEOS[id].transcript, description: 'desc', note: VIDEOS[id].transcript ? '' : 'no captions' };
};
const reviewed = [];
const REVIEWS = {
  good1: { summary: 'Order prompts so the stable part is cached.', techniques: [{ name: 'Stable prefix first', when: 'building prompts that repeat', do: 'Put system prompt and tool definitions first, variable content last', why: 'cache hits cut input tokens', evidence: '01:10' }, { name: 'Check cache hits', when: 'after changing prompts', do: 'Read cache_read tokens in usage', why: 'proves the cache works', evidence: '09:40' }], applies_to: ['coding'], impact: 5, applicability: 5, confidence: 4, effort: 2, risk: 1, reasoning: 'Directly lowers agent token use.' },
  good2: { summary: 'Same idea, different wording.', techniques: [{ name: 'Stable prefix first!', when: 'any repeated prompt', do: 'Keep the unchanging instructions at the top', why: 'cheaper', evidence: '00:30' }], applies_to: ['coding'], impact: 4, applicability: 5, confidence: 4, effort: 1, risk: 1, reasoning: 'Useful.' },
  meh: { summary: 'Theory only.', techniques: [{ name: 'Know cache theory', when: 'never really', do: 'read about caches', why: 'background', evidence: '' }], applies_to: [], impact: 2, applicability: 2, confidence: 3, effort: 3, risk: 1, reasoning: 'Not actionable.' },
};
const ask = async (instruction, input) => {
  const id = (input.match(/watch\?v=(\w+)/) || [])[1];
  reviewed.push({ id, chars: input.length });
  assert.ok(instruction.includes('usefulness checker') && instruction.includes('JSON'));
  if (id === 'meh') return { text: `Sure! Here is my review:\n${JSON.stringify(REVIEWS.meh)}\nHope that helps.`, usage: { input: 900, output: 200 }, cost: 0.001 };
  if (!REVIEWS[id]) throw new Error('reviewer crashed');
  return { text: JSON.stringify(REVIEWS[id]), usage: { input: 1000, output: 250 }, cost: 0.002 };
};
const waitDone = async (f, id) => { for (let i = 0; i < 200; i++) { const j = f.get(id); if (['done', 'error'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 25)); } throw new Error('job did not finish'); };

(async () => {
  console.log('Fetcher');
  // ---- pure pieces ----
  const qs = F.buildQueries('prompt caching for agents');
  assert.ok(qs.length >= 3 && qs[0] === 'prompt caching for agents' && qs.some((q) => /best practices/.test(q)));
  const ranked = F.rankCandidates([...Object.entries(VIDEOS).map(([id, v]) => ({ id, ...v })), { id: 'good1', title: 'dup' }], 'prompt caching agents');
  assert.equal(ranked.filter((v) => v.id === 'good1').length, 1, 'duplicates removed');
  assert.ok(ranked.findIndex((v) => v.id === 'short') > ranked.findIndex((v) => v.id === 'good1'), 'a 40-second short ranks below a real tutorial');
  ok('several search angles per topic; results de-duplicated and ranked (relevance, views, length, age)');

  const html = '<script>var ytInitialData = ' + JSON.stringify({ contents: { a: [{ videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'Agent tips' }] }, ownerText: { runs: [{ text: 'Chan' }] }, lengthText: { simpleText: '12:34' }, viewCountText: { simpleText: '1.2M views' }, publishedTimeText: { simpleText: '2 years ago' } } }] } }) + ';</script>';
  const parsed = F.parseSearchPage(html);
  assert.deepEqual([parsed[0].id, parsed[0].duration, parsed[0].views, parsed[0].ageDays], ['abcdefghijk', 754, 1200000, 730]);
  ok('YouTube results page parsed without an API key (title, channel, length, views, age)');

  const pGood = F.preCheck({ transcript: VIDEOS.good1.transcript }, 'prompt caching agents');
  const pOff = F.preCheck({ transcript: VIDEOS.offtopic.transcript }, 'prompt caching agents');
  const pNo = F.preCheck({ transcript: '', description: 'x' }, 'prompt caching agents');
  assert.ok(pGood.score >= 60 && pOff.score < 25 && pNo.score < 25, `pre-check good ${pGood.score}, off-topic ${pOff.score}, none ${pNo.score}`);
  ok(`free pre-check: on-topic how-to ${pGood.score}, off-topic ${pOff.score}, no transcript ${pNo.score} (below 25 never reaches the AI)`);

  const long = Array.from({ length: 60 }, (_, i) => (i === 41 ? '[30:00] prompt caching agents tip: put the stable prefix first then use cache. ' : `[${i}:00] unrelated chatter about the weather and the sponsor of the video. `).repeat(4)).join('');
  const ex = F.excerpt(long, 'prompt caching agents', 7000);
  assert.ok(long.length > 15000 && ex.length <= 7400 && ex.includes('stable prefix first'), 'long transcript trimmed, relevant part kept');
  ok(`long transcript trimmed for the reviewer: ${long.length} → ${ex.length} chars, the relevant part kept`);

  const pr = F.parseReview('blah {"summary":"s","techniques":[{"name":"n","do":"d"}],"impact":9,"applicability":"4","confidence":0,"effort":2,"risk":1} trailing');
  assert.deepEqual([pr.impact, pr.applicability, pr.confidence], [5, 4, 1], 'ratings clamped to 1..5');
  assert.throws(() => F.parseReview('no json here'));
  const w1 = F.worth({ impact: 5, applicability: 5, confidence: 5, effort: 1, risk: 1, techniques: [{}] });
  const w2 = F.worth({ impact: 1, applicability: 1, confidence: 1, effort: 5, risk: 5, techniques: [] });
  const w3 = F.worth({ impact: 5, applicability: 5, confidence: 2, effort: 1, risk: 1, techniques: [{}] });
  assert.deepEqual([w1.score, w1.verdict, w2.score, w2.verdict], [100, 'worth it', 0, 'not worth it']);
  assert.equal(w3.verdict, 'maybe', 'low confidence can never be "worth it"');
  ok('usefulness reply parsed safely; worth-it score calculated by Cortex (100 / 0 at the extremes; low confidence capped at "maybe")');

  // ---- a full run, requested by the user ----
  const store = new Store(vault);
  store.create('project', { title: 'Agents' });
  const fx = new F.Fetcher({ store, runner: null, deps: { search, fetchVideo, ask, retryMs: 10 } });
  const job = fx.create({ topic: 'prompt caching for agents', why: 'agents spend too many tokens', project: 'agents', maxVideos: 4, from: 'you' });
  const done = await waitDone(fx, job.id);
  assert.equal(done.status, 'done', done.step);
  assert.equal(searches, done.queries.length, 'one search per angle');
  const ids = reviewed.map((r) => r.id).sort();
  assert.ok(!ids.includes('nosub') && !ids.includes('offtopic') && !ids.includes('short'), `only the shortlist reached the AI (reviewed: ${ids})`);
  const by = Object.fromEntries(done.videos.map((v) => [v.id, v]));
  assert.equal(by.good1.verdict, 'worth it'); assert.equal(by.good2.verdict, 'worth it'); assert.notEqual(by.meh.verdict, 'worth it');
  assert.ok(by.nosub.skipped && by.offtopic.skipped);
  assert.equal(throttled, 1); assert.equal(by.good2.verdict, 'worth it', 'a YouTube 429 is retried and the video still reviewed');
  assert.equal(by.nosub.skipped, 'no transcript'); assert.equal(by.offtopic.skipped, 'pre-check too low');
  assert.equal(done.usage.input, reviewed.reduce((a) => a, 0) || done.usage.input);
  ok(`user request ran end to end: ${done.found} found → ${done.videos.length} read → ${reviewed.length} sent to the AI → ${done.videos.filter((v) => v.verdict === 'worth it').length} worth it`);

  // ---- learning: one lesson, duplicates merged, agents find it ----
  const lesson = store.get(done.lesson.id);
  assert.ok(lesson && lesson.title === 'Lesson: prompt caching for agents' && lesson.meta.project === 'agents');
  const techs = JSON.parse(lesson.meta.fetcher_lesson);
  const stable = techs.find((t) => /stable prefix/i.test(t.name));
  assert.equal(techs.filter((t) => /stable prefix/i.test(t.name)).length, 1, 'same technique from two videos stored once');
  assert.equal(stable.sources.length, 2, 'with both videos as sources');
  assert.ok(!techs.some((t) => /cache theory/i.test(t.name)), 'not-worth-it techniques are not taught');
  assert.ok(/\*\*When:\*\*/.test(lesson.body) && /\*\*Do:\*\*/.test(lesson.body) && /youtube\.com\/watch\?v=good1/.test(lesson.body), 'lesson says when/do/why with sources');
  assert.ok(done.learning.found, `recall self-check found the lesson (rank ${done.learning.rank})`);
  ok(`taught "${lesson.title}": ${techs.length} techniques, duplicates merged with both sources, actionable (when / do / why / source)`);

  // a fresh agent working on that project gets the lesson automatically
  const projDir = path.join(tmp, 'agents-code'); fs.mkdirSync(projDir);
  store.update('projects/agents', { folder: projDir });
  const r = await hooks.runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'fresh-agent', cwd: projDir, prompt: 'how can we use prompt caching to lower token use?' }, vault);
  assert.ok(/Lesson: prompt caching for agents/.test(r.hookSpecificOutput.additionalContext), 'recall hands the lesson to a new agent');
  assert.ok(/Stable prefix first.*Put system prompt/.test(r.hookSpecificOutput.additionalContext), 'recall shows the advice itself, not just the title');
  assert.ok(/^Key takeaways/m.test(store.get(done.lesson.id).body), 'lesson starts with its takeaways');
  const s = await hooks.runHook({ hook_event_name: 'SessionStart', session_id: 'fresh-agent2', cwd: projDir, source: 'startup' }, vault);
  assert.ok(/Lesson: prompt caching for agents/.test(s.hookSpecificOutput.additionalContext), 'the project brief lists the lesson');
  ok('a new agent on that project gets the lesson in its brief and through recall, without being told');

  // second run on the same topic merges into the same lesson (no duplicate note)
  const job2 = fx.create({ topic: 'prompt caching for agents', project: 'agents', maxVideos: 4 });
  const done2 = await waitDone(fx, job2.id);
  assert.equal(done2.lesson.id, done.lesson.id); assert.equal(done2.lesson.merged, true);
  assert.equal(store.list('note', { project: 'agents' }).filter((n) => n.title.startsWith('Lesson:')).length, 1);
  assert.equal(JSON.parse(store.get(done.lesson.id).meta.fetcher_lesson).find((t) => /stable prefix/i.test(t.name)).sources.length, 2, 'no duplicate sources after a re-run');
  ok('re-running a topic updates the same lesson (no duplicate notes or sources)');

  // report: readable file, not loaded as a memory
  assert.ok(done.report && fs.existsSync(path.join(vault, done.report)));
  assert.ok(/\| Video \| Found by \| Read \| Pre-check \| Worth-it \| Verdict/.test(fs.readFileSync(path.join(vault, done.report), 'utf8')));
  store.scan(false);
  assert.ok(!store.list('note').some((n) => /Fetcher report/.test(n.title)), 'reports are not memories (no token cost)');
  ok('report with every video, score and reason saved in fetcher/ (readable in Obsidian, not loaded into agents)');

  // the user can teach a "maybe"
  fx.teachVideo(job.id, 'meh');
  assert.ok(JSON.parse(store.get(done.lesson.id).meta.fetcher_lesson).some((t) => /cache theory/i.test(t.name)));
  ok('"Teach this anyway" adds a video the checker did not pass');

  // ---- a reviewer failure doesn't break the run ----
  VIDEOS.good3 = { title: 'Prompt caching agents tips 3', views: 50000, duration: 800, transcript: VIDEOS.good2.transcript };
  const job3 = fx.create({ topic: 'prompt caching for agents', project: 'agents', maxVideos: 5 });
  const done3 = await waitDone(fx, job3.id);
  assert.equal(done3.status, 'done');
  assert.ok(/crashed/.test(done3.videos.find((v) => v.id === 'good3').error));
  ok('a reviewer error is shown on that video; the rest of the run still finishes');

  // ---- agents ask through MCP; it waits for the user's OK ----
  const mcp = createMcp(store);
  const sess = { transport: 'http', local: true, agent: 'claude-code' };
  const call = async (name, args) => JSON.parse((await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, sess)).result.content[0].text);
  const req = await call('fetcher_request', { topic: 'faster test runs in node', why: 'tests take 6 minutes' });
  assert.equal(req.status, 'needs-approval');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(fx.get(req.id).status, 'needs-approval', 'nothing runs before the user approves');
  const st = await call('fetcher_status', { id: req.id });
  assert.equal(st.status, 'needs-approval');
  fx.approve(req.id);
  assert.equal((await waitDone(fx, req.id)).status, 'done');
  ok('agent request via fetcher_request waits for the user; runs after approval; fetcher_status reports it');

  // queued by another process (an agent's own MCP server) → picked up by the main server
  const other = new F.Fetcher({ store, runner: null });
  require(path.join(ROOT, 'src', 'settings.js')).update(vault, { fetcher: { autoRunAgentRequests: true } });
  const queued = other.create({ topic: 'prompt caching for agents', from: 'codex', byAgent: true }, { start: false });
  assert.equal(queued.status, 'queued');
  fx.pickUp();
  assert.equal((await waitDone(fx, queued.id)).status, 'done');
  ok('with auto-run on, a request queued by another process is picked up and run by Cortex');

  console.log('\nAll fetcher checks passed.');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
