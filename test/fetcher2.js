'use strict';
// Fetcher 2: understanding plain-language requests and spoken videos, and searching beyond titles.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-fetcher2-'));
process.env.USERPROFILE = path.join(tmp, 'home'); process.env.HOME = process.env.USERPROFILE;
const vault = path.join(tmp, 'vault');
const ok = (m) => console.log('  ✓ ' + m);
const R = require(path.join(ROOT, 'src', 'reader.js'));
const F = require(path.join(ROOT, 'src', 'fetcher.js'));
const { Store } = require(path.join(ROOT, 'src', 'store.js'));

(async () => {
  console.log('Fetcher: speech, reading, searching');

  // ---- speech ----
  const rolled = R.dedupeCues([{ start: 0, text: 'so today we are going' }, { start: 2, text: 'we are going to set up' }, { start: 4, text: 'to set up the hooks' }, { start: 6, text: 'to set up the hooks' }]);
  assert.deepEqual(rolled.map((c) => c.text), ['so today we are going', 'to set up', 'the hooks']);
  ok('auto-caption rolling duplicates merged ("we are going" / "we are going to set up" → one sentence)');

  const cleaned = R.cleanSpeech('[0:12] Um, so [Music] you you open the the terminal, uh, and type it. I like the way it, you know, works.');
  assert.equal(cleaned, '[0:12] so you open the terminal, and type it. I like the way it, you know, works.');
  ok('filler and caption tags removed conservatively ("like" and "you know" kept), stutters fixed, timestamps kept');

  const g = R.buildGlossary({ title: 'Claude Code Is Wasting Tokens... Microsoft Built a Fix', description: 'Install TokenEconomizer in Claude Code. Uses MCP and the GitHub CLI.', tags: ['claude code', 'AI agents'], vocab: ['context window'] });
  assert.ok(g.includes('Claude Code') && g.includes('TokenEconomizer') && g.includes('MCP') && g.includes('context window'));
  assert.ok(!g.includes('Claude Code Is') && !g.includes('Microsoft Built'), 'headline words are not names');
  const fixed = R.correctTerms('[1:00] open cloud code, add the token economizer plugin, check your m c p servers and chat gpt too', g, 'Claude Code video');
  assert.equal(fixed.text, '[1:00] open Claude Code, add the TokenEconomizer plugin, check your MCP servers and ChatGPT too');
  assert.ok(fixed.fixes >= 4);
  assert.equal(R.correctTerms('deploy your cloud code to the cloud', [], 'Google Cloud tutorial').text, 'deploy your cloud code to the cloud', 'no "Claude" fix on a real cloud video');
  ok('glossary from the video itself; misheard terms fixed ("cloud code" → Claude Code, "token economizer" → TokenEconomizer) only when the video is about them');

  // ---- structure, screen, links, viewers ----
  const ch = R.chaptersFrom(null, 'Chapters:\n0:00 Intro\n1:30 Installing the hooks\n4:05 Testing it\nlinks below');
  assert.deepEqual(ch.map((c) => c.start), [0, 90, 245]);
  const times = R.pickFrameTimes('[0:00] Hi there.\n\n[1:30] As you can see, the hooks file is open. Then we wait.\n\n[3:00] Now type this command in the terminal.', { chapters: ch, duration: 400, vocab: ['hooks'], max: 4 });
  assert.ok(times.length >= 3 && times.every((t, i, a) => i === 0 || t.t - a[i - 1].t >= 25));
  assert.ok(times.some((t) => /as you can see/i.test(t.why)) && times.some((t) => /type this/i.test(t.why)));
  ok('chapters read from the description; screen moments picked where the speaker points at the screen and at chapter starts');

  const links = R.pickLinks('Code: https://github.com/microsoft/TokenEconomizer\nDocs https://docs.example.dev/hooks\nFollow me https://twitter.com/me\nSponsor: 20% off https://shop.example.com/?ref=abc\nMy course https://skool.com/x', ['hooks']);
  assert.deepEqual(links.map((l) => new URL(l.url).hostname), ['docs.example.dev', 'github.com']);
  ok('linked pages: docs and repos about the topic kept; social, sponsor and course links skipped');

  const cm = R.topComments([{ text: 'great vid', like_count: 900 }, { text: 'This no longer works since v2, use the settings file instead', like_count: 40 }, { text: 'Pinned: update for 2026 users, see description', like_count: 3, is_pinned: true, author_is_uploader: true }, { text: 'agree with the comment above, thanks', like_count: 5, parent: 'abc' }]);
  assert.equal(cm[0].pinned, true); assert.ok(cm.some((c) => /no longer works/.test(c.text))); assert.ok(!cm.some((c) => /agree with/.test(c.text)), 'replies skipped');
  ok('top comments: pinned and creator first, then most-liked; one-word and reply comments skipped');

  // ---- searching ----
  assert.equal(F.encodeSp({}), 'EgIQAQ==');
  assert.equal(F.encodeSp({ upload: 'year' }), 'EgQIBRAB');
  assert.equal(F.encodeSp({ sort: 'views' }), 'CAMSAhAB');
  assert.equal(F.encodeSp({ length: 'long', upload: 'month', sort: 'date' }), 'CAISBggEEAEYAg==');
  ok('YouTube filters encoded exactly as YouTube expects (videos only, upload date, length, sort)');

  const relHtml = '<script>var ytInitialData = ' + JSON.stringify({ x: [{ lockupViewModel: { contentId: 'AAAAAAAAAAA', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentImage: { b: { text: '12:05' } }, metadata: { lockupMetadataViewModel: { title: { content: 'Related one' }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Chan' } }] }, { metadataParts: [{ text: { content: '95K views' } }, { text: { content: '2 weeks ago' } }] }] } } } } } }, { lockupViewModel: { contentId: 'PLxxxx', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: {} } }] }) + ';</script>';
  const rel = F.parseRelated(relHtml);
  assert.deepEqual(rel.map((v) => [v.id, v.title, v.channel, v.views, v.duration, v.ageDays]), [['AAAAAAAAAAA', 'Related one', 'Chan', 95000, 725, 14]]);
  ok('related videos parsed from the watch page (playlists ignored)');

  assert.deepEqual(F.localFilter([{ id: 'a', channel: 'Good Chan', views: 5000 }, { id: 'b', channel: 'Spam TV', views: 90000 }, { id: 'c', channel: 'Good Chan', views: 10 }], { excludeChannels: ['spam'], minViews: 1000 }).map((v) => v.id), ['a']);
  ok('channel include/exclude and minimum views applied');

  const plan = F.parsePlan('Here you go: {"goal":"stop agents re-reading files","concepts":["context reuse"],"vocabulary":["context window","re-reading","file reads"],"queries":["claude code reading same files","reduce file reads agents"],"must_have":["concrete steps"],"avoid":["intro to AI"],"recency":"year","length":"weird"} done');
  assert.equal(plan.recency, 'year'); assert.equal(plan.length, 'any'); assert.equal(plan.queries.length, 2);
  ok('planner reply parsed safely (bad values fall back)');

  // ---- a full run: plain-language request → planner → filtered searches → related → reading → review ----
  const store = new Store(vault);
  const calls = { search: [], related: [], read: [], reviewInputs: [], plan: 0 };
  const T = (txt) => `[0:00] ${txt} `.repeat(60);
  const VIDS = {
    a1: { title: 'Stop Claude Code re-reading files: context window tricks', channel: 'Pro Dev', views: 80000, duration: 900, transcript: T('use a project map so the agent does not re-read files, first make sure the context window stays small, then use cached summaries') },
    a2: { title: 'Reduce file reads for coding agents', channel: 'Spam TV', views: 999999, duration: 600, transcript: T('reduce file reads') },
    a3: { title: 'Agents keep reading the same files', channel: 'Small Chan', views: 300, duration: 700, transcript: T('agents re-reading files') },
    r1: { title: 'Context window management deep dive', channel: 'Pro Dev', views: 50000, duration: 1200, transcript: T('context window file reads first then make sure you use summaries instead of re-reading') },
  };
  const deps = {
    planAsk: async (instr, input) => {
      calls.plan++;
      if (/continuing YouTube research/.test(instr)) return { text: '{"missing":"tool comparisons","queries":["context tools comparison 2026"]}', model: 'claude-haiku-5-5' };
      assert.ok(/everyday words/.test(instr) && /my agents keep reading the same stuff/.test(input));
      return { text: JSON.stringify({ goal: 'Stop agents re-reading the same files', concepts: ['context reuse'], vocabulary: ['context window', 're-reading', 'file reads', 'project map'], queries: ['claude code re-reading files', 'reduce file reads agents'], must_have: ['concrete steps'], avoid: ['beginner intros'], recency: 'year', length: 'medium' }), usage: { input: 300, output: 120 }, cost: 0.001, model: 'claude-haiku-5-5' };
    },
    search: async (q, n, filters) => { calls.search.push({ q, filters }); return [VIDS.a1, VIDS.a2, VIDS.a3].map((v, i) => ({ id: ['a1', 'a2', 'a3'][i], ...v })); },
    related: async (id) => { calls.related.push(id); return [{ id: 'r1', ...VIDS.r1 }]; },
    read: async (id, o) => { calls.read.push({ id, full: !!(o && o.full) }); const v = VIDS[id]; return { id, title: v.title, transcript: v.transcript, transcriptSource: 'auto-captions', speechFixes: 2, glossary: ['Claude Code'], chapters: [{ start: 0, title: 'Intro' }, { start: 60, title: 'Context window tricks' }], description: 'desc', tags: [], comments: o && o.full ? [{ text: 'This works, but in 2026 use the built-in index instead', likes: 30 }] : [], links: o && o.full ? [{ url: 'https://github.com/x/y', title: 'repo', excerpt: 'readme' }] : [], frames: o && o.full && id === 'a1' ? [{ t: 65, at: '1:05', why: 'as you can see', file: path.join(o.framesDir || tmp, 'frame-00065.jpg') }] : [], notes: [] }; },
    ask: async (instr, input, opts) => {
      calls.reviewInputs.push({ input, opts });
      const id = (input.match(/watch\?v=(\w+)/) || [])[1];
      return { text: JSON.stringify({ summary: 's', techniques: [{ name: `Technique ${id}`, when: 'when reading', do: 'keep a map', why: 'fewer tokens', evidence: 'on screen at 1:05' }], impact: 4, applicability: 4, confidence: 4, effort: 2, risk: 1, outdated: id === 'a3', meets_request: true, reasoning: 'r' }), usage: { input: 1000, output: 200 }, cost: 0.01, model: 'claude-sonnet-5-5' };
    },
    retryMs: 5,
  };
  const fx = new F.Fetcher({ store, runner: null, deps });
  const job = fx.create({ topic: 'my agents keep reading the same stuff over and over, find me something on fixing that', maxVideos: 3, depth: 'deep', excludeChannels: 'spam tv', queries: ['my own search'], sort: 'views' });
  let done; for (let i = 0; i < 400; i++) { done = fx.get(job.id); if (['done', 'error'].includes(done.status)) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(done.status, 'done', done.step);
  assert.equal(done.plan.goal, 'Stop agents re-reading the same files');
  assert.ok(done.searches.some((s) => s.q === 'my own search' && s.by === 'you') && done.searches.some((s) => s.by === 'planner') && done.searches.some((s) => s.by === 'follow-up'));
  assert.deepEqual(calls.search[0].filters, { sort: 'views', upload: 'year', length: 'medium' }, 'planner recency/length used; your sort kept');
  ok('a plain-language request is understood (goal, vocabulary, searches from several angles + yours + filters)');

  assert.ok(!done.videos.some((v) => v.id === 'a2'), 'excluded channel never read');
  assert.ok(calls.related.length >= 1 && done.videos.some((v) => v.id === 'r1' && v.via), 'found via related videos');
  ok('beyond the searches: a related video found and read; excluded channel skipped');

  const full = calls.read.filter((r) => r.full).map((r) => r.id);
  assert.ok(full.length >= 2 && calls.read.some((r) => !r.full), 'light read for the pool, full read for the shortlist');
  const a1in = calls.reviewInputs.find((r) => /watch\?v=a1/.test(r.input));
  assert.ok(/their own words\): "my agents keep reading/.test(a1in.input), 'reviewer sees the original request');
  assert.ok(/Core need \(a useful video must help with this\): concrete steps/.test(a1in.input) && /Not useful if: beginner intros/.test(a1in.input));
  assert.ok(/Correct spellings/.test(a1in.input) && /Chapters: 0:00 Intro; 1:00 Context window tricks/.test(a1in.input));
  assert.ok(/Top viewer comments/.test(a1in.input) && /Pages linked from the description/.test(a1in.input) && /frame-00065\.jpg at 1:05/.test(a1in.input));
  assert.equal(a1in.opts.tools, 'Read', 'reviewer may look at screen frames');
  ok('reviewer gets the whole dossier: request, goal, must/avoid, glossary, chapters, comments, linked pages, screen frames (with Read)');

  assert.notEqual(done.videos.find((v) => v.id === 'a3').verdict, 'worth it', 'outdated content is never "worth it"');
  assert.equal(done.models.planner, 'claude-haiku-5-5'); assert.equal(done.models.reviewer, 'claude-sonnet-5-5');
  assert.ok(done.videos.some((v) => v.round === 2) || done.searches.some((s) => s.by === 'follow-up'), 'deep: second round ran');
  ok('outdated videos capped at "maybe"; planner and reviewer models recorded; deep mode runs a second round');

  // ---- lessons stay sharp ----
  const many = { topic: 'cap test', project: undefined, threshold: 60, models: {}, videos: Array.from({ length: 5 }, (_, i) => ({ id: 'v' + i, title: 'V' + i, score: 70 + i, verdict: 'worth it', review: { techniques: Array.from({ length: 4 }, (_, k) => ({ name: `T ${i} ${k}`, when: 'w', do: 'd', why: 'y', evidence: 'e' })) } })) };
  const l = F.teach(store, many);
  assert.equal(l.techniques, F.MAX_TECHNIQUES); assert.equal(l.dropped, 20 - F.MAX_TECHNIQUES);
  assert.ok(/last confirmed \d{4}-\d{2}-\d{2}/.test(store.get(l.id).body));
  ok(`lessons are capped at the ${F.MAX_TECHNIQUES} strongest techniques, each with a "last confirmed" date`);

  // the lesson gets a clean name from the planner, and a similar later request extends it instead of starting another
  assert.ok(done.lesson && /^Lesson: /.test(done.lesson.title));
  const mk = (topic, planTopic) => ({ topic, project: undefined, threshold: 60, models: {}, plan: { topic: planTopic }, videos: [{ id: 'z' + planTopic.length, title: 'Z', score: 80, verdict: 'worth it', review: { techniques: [{ name: 'Use a repo map ' + planTopic.length, when: 'w', do: 'd', why: 'y', evidence: 'e' }] } }] });
  const l1 = F.teach(store, mk('my agents keep re-reading the same files over and over, help', 'Stop agents re-reading files'));
  assert.equal(store.get(l1.id).title, 'Lesson: Stop agents re-reading files', 'clean name, not the raw sentence');
  const l2 = F.teach(store, mk('how do i stop claude re reading files', 'Stop agents re-reading the same files'));
  assert.equal(l2.id, l1.id); assert.equal(l2.merged, true);
  ok('lessons get a short, clean name from the planner; a similar later request extends the same lesson');

  // ---- usage control: presets, per-run limit, daily limit, one run at a time ----
  const lowJob = fx.create({ topic: 'usage preset check', usage: 'low' }, { start: false });
  assert.deepEqual([lowJob.usageLevel, lowJob.maxVideos, lowJob.model, lowJob.opts.depth, lowJob.opts.frames, lowJob.budget], ['low', 2, 'haiku', 'quick', false, 0.05]);
  const custom = fx.create({ topic: 'custom check', usage: 'custom', maxVideos: 7, budget: 0.4, depth: 'deep' }, { start: false });
  assert.deepEqual([custom.maxVideos, custom.budget, custom.opts.depth], [7, 0.4, 'deep']);
  ok('usage levels set videos, depth, model, frames and a spending limit; Custom uses exactly what you set');

  const pricey = { ...deps, ask: async (i, input) => ({ text: JSON.stringify({ summary: 's', techniques: [{ name: 'x ' + Math.random(), do: 'd', evidence: 'e' }], impact: 4, applicability: 4, confidence: 4, effort: 2, risk: 1, reasoning: 'r' }), usage: { input: 9000, output: 900 }, cost: 0.2 }) };
  const fxB = new F.Fetcher({ store, runner: null, deps: pricey });
  const bj = fxB.create({ topic: 'budget stop check about context window re-reading files', usage: 'custom', maxVideos: 3, budget: 0.25, depth: 'quick', related: false, planner: false });
  let bd; for (let i = 0; i < 400; i++) { bd = fxB.get(bj.id); if (['done', 'error'].includes(bd.status)) break; await new Promise((r) => setTimeout(r, 20)); }
  const reviewedN = bd.videos.filter((v) => v.review).length;
  assert.ok(reviewedN < 3 && bd.videos.some((v) => /usage limit/.test(v.skipped || '')) && bd.usage.cost <= 0.25 + 0.2, `stopped at the limit (reviewed ${reviewedN}, spent ${bd.usage.cost})`);
  ok(`per-run limit: stopped after ${reviewedN} review(s) at $${bd.usage.cost.toFixed(2)} of $0.25; the rest marked "usage limit reached"`);

  require(path.join(ROOT, 'src', 'settings.js')).update(vault, { fetcher: { dailyBudget: 0.1 } });
  const dj = fxB.create({ topic: 'daily limit check context window', usage: 'low', related: false });
  let dd; for (let i = 0; i < 200; i++) { dd = fxB.get(dj.id); if (dd.waitUntil || ['done', 'error'].includes(dd.status)) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(dd.status, 'queued'); assert.ok(dd.waitUntil && /Daily Fetcher limit reached/.test(dd.step));
  require(path.join(ROOT, 'src', 'settings.js')).update(vault, { fetcher: { dailyBudget: 0 } });
  ok('daily limit: once today\'s spending reaches it, new runs wait until tomorrow instead of spending');

  const slow = { ...deps, search: async (...a) => { await new Promise((r) => setTimeout(r, 150)); return deps.search(...a); } };
  const fxQ = new F.Fetcher({ store: new Store(path.join(tmp, 'vault-queue')), runner: null, deps: slow }); // its own vault: one Fetcher per vault, like the server
  const q1 = fxQ.create({ topic: 'queue one context window', usage: 'low', related: false });
  const q2 = fxQ.create({ topic: 'queue two context window', usage: 'low', related: false });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fxQ.running.size, 1); assert.equal(fxQ.get(q2.id).status, 'queued');
  for (let i = 0; i < 400; i++) { if (fxQ.get(q2.id).status === 'done') break; await new Promise((r) => setTimeout(r, 25)); }
  assert.equal(fxQ.get(q1.id).status, 'done'); assert.equal(fxQ.get(q2.id).status, 'done');
  ok('one research run at a time: the second waits, then starts by itself when the first finishes');

  // ---- learning quality: evidence required, near-duplicates merged ----
  const lq = F.teach(store, { topic: 'quality check', threshold: 60, models: {}, plan: { topic: 'Quality check lesson' }, videos: [
    { id: 'q1', title: 'Q1', score: 80, verdict: 'worth it', review: { techniques: [{ name: 'Keep a repo map file', do: 'map', evidence: '01:10 transcript' }, { name: 'Vague idea', do: 'x', evidence: '' }] } },
    { id: 'q2', title: 'Q2', score: 75, verdict: 'worth it', review: { techniques: [{ name: 'Keep a repo map', do: 'map it', evidence: 'on screen 2:00' }] } },
  ] });
  const lt = JSON.parse(store.get(lq.id).meta.fetcher_lesson);
  assert.ok(!lt.some((t) => /Vague idea/.test(t.name)), 'no evidence → not taught');
  assert.equal(lt.length, 1); assert.equal(lt[0].sources.length, 2, 'near-duplicate names merged');
  assert.ok(/2 videos agree/.test(store.get(lq.id).body));
  ok('techniques need evidence to be taught; near-duplicates from different videos merge and show "N videos agree"');

  console.log('\nAll Fetcher 2 checks passed.');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
