'use strict';
// Tasks for the Train AI experiment. Each has: a prompt, lessons (in Fetcher's technique format) that Cortex can
// teach, and hidden tests that score the model's code locally.
const vm = require('vm');

function load(code, fnName) {
  const sandbox = { module: { exports: {} }, exports: {}, console: { log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\n;this.__fn = typeof ${fnName} !== 'undefined' ? ${fnName} : (module.exports.${fnName} || module.exports);`, sandbox, { timeout: 2000 });
  if (typeof sandbox.__fn !== 'function') throw new Error(`no function ${fnName}`);
  return sandbox.__fn;
}

function runCases(code, fnName, cases) {
  let fn;
  try { fn = load(code, fnName); } catch (e) { return { passed: 0, total: cases.length, failures: ['does not load: ' + e.message.slice(0, 120)] }; }
  let passed = 0;
  const failures = [];
  for (const [args, want] of cases) {
    let got;
    try { got = fn(...args); } catch (e) { got = 'THROWS ' + e.message; }
    const norm = (v) => (typeof v === 'number' ? Math.sign(v) : v);
    if (JSON.stringify(norm(got)) === JSON.stringify(norm(want))) passed++;
    else if (failures.length < 6) failures.push(`${JSON.stringify(args)} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
  }
  return { passed, total: cases.length, failures };
}

// ---------- Task 1: SemVer precedence (technique: work from the spec's rules, test the edge cases) ----------
const SEMVER = [
  [['1.0.0', '2.0.0'], -1], [['2.0.0', '2.1.0'], -1], [['2.1.0', '2.1.1'], -1], [['1.10.0', '1.9.0'], 1], [['1.0.0', '1.0.0'], 0],
  [['1.0.0-alpha', '1.0.0'], -1], [['1.0.0', '1.0.0-rc.1'], 1],
  [['1.0.0-alpha', '1.0.0-alpha.1'], -1], [['1.0.0-alpha.1', '1.0.0-alpha.beta'], -1], [['1.0.0-alpha.beta', '1.0.0-beta'], -1],
  [['1.0.0-beta', '1.0.0-beta.2'], -1], [['1.0.0-beta.2', '1.0.0-beta.11'], -1], [['1.0.0-beta.11', '1.0.0-rc.1'], -1], [['1.0.0-rc.1', '1.0.0'], -1],
  [['1.0.0-alpha.10', '1.0.0-alpha.9'], 1], [['1.0.0-1', '1.0.0-alpha'], -1], [['1.0.0-alpha.1', '1.0.0-alpha.1.1'], -1],
  [['1.0.0+build.1', '1.0.0+build.2'], 0], [['1.0.0-alpha+001', '1.0.0-alpha'], 0], [['1.0.0+20130313144700', '1.0.0'], 0],
  [['v1.2.3', '1.2.3'], 0], [['1.0.0-rc.1+build.5', '1.0.0-rc.1'], 0], [['1.0.0-x.7.z.92', '1.0.0-x.7.z.93'], -1],
  [['1.0.0-0.3.7', '1.0.0-alpha'], -1], [['1.0.0-ALPHA', '1.0.0-alpha'], -1], [['10.0.0', '9.99.99'], 1],
];
const semver = {
  prompt: 'Write a JavaScript function `compareVersions(a, b)` that compares two version strings using Semantic Versioning 2.0.0 precedence. Return -1 if a < b, 0 if equal precedence, 1 if a > b. Accept an optional leading "v". Reply with only the code in one ```js block.',
  lessons: [{ topic: 'comparing semantic version strings correctly', sources: ['SemVer 2.0.0 spec walkthrough', 'Version sorting bugs we shipped'], techniques: [
    { name: 'Spec-rule checklist before coding', when: 'implementing comparison of semantic version strings', do: 'List the precedence rules first: strip a leading v; DROP build metadata after + entirely (it never affects order); compare major.minor.patch numerically; a version WITH a pre-release is LOWER than the same version without; compare pre-release identifiers split on dots one by one: numeric ids compare as numbers, alphanumeric ids compare by ASCII (so uppercase sorts before lowercase), numeric ids are always lower than alphanumeric ids, and if all shared ids are equal the longer list is greater.', why: 'Most version bugs come from forgetting one of these rules (build metadata, numeric vs string ids, longer pre-release wins).' },
    { name: 'Test the spec example chain', when: 'checking a version comparator', do: 'Verify this exact ascending chain: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0, plus 1.10.0 > 1.9.0 and 1.0.0+a == 1.0.0+b.', why: 'The chain covers every tricky rule in a few comparisons.' },
  ] }],
  total: SEMVER.length,
  score: (code) => runCases(code, 'compareVersions', SEMVER),
};

// ---------- Task 2: Cortex journal header (house knowledge the model cannot know without being taught) ----------
const JOURNAL = [
  [[{ time: '2026-11-20T14:05:00', agent: 'claude-code', status: 'done', source: 'started from Cortex' }], '### 14:05 · claude-code · ✓ finished (started from Cortex)'],
  [[{ time: '2026-11-20T09:30:00', agent: 'codex', status: 'error' }], '### 09:30 · codex · ✗ failed'],
  [[{ time: '2026-11-20T23:59:00', agent: 'claude-haiku', status: 'stopped', source: 'phone' }], '### 23:59 · claude-haiku · ■ stopped (phone)'],
  [[{ time: '2026-01-02T00:00:00', agent: 'gpt', status: 'done' }], '### 00:00 · gpt · ✓ finished'],
  [[{ time: '2026-11-20T07:08:00', agent: '', status: 'done' }], '### 07:08 · agent · ✓ finished'],
  [[{ time: '2026-11-20T12:00:00', agent: 'codex', status: 'cancelled', source: '' }], '### 12:00 · codex · ■ stopped'],
];
const journal = {
  prompt: 'Write a JavaScript function `journalHeader(session)` for Cortex, the user\'s AI project manager. It returns the Markdown header line Cortex writes in a project\'s agent journal for one agent session. `session` has: time (ISO string, local time), agent (name), status ("done", "error", "stopped" or "cancelled") and optional source. Follow Cortex\'s journal format exactly. Reply with only the code in one ```js block.',
  lessons: [{ topic: 'Cortex agent journal format', sources: ['Cortex journal.js', 'Cortex experience digest parser'], techniques: [
    { name: 'Cortex journal header format', when: 'writing a session header line for a Cortex agent journal', do: 'Write exactly "### HH:MM · <agent> · <mark>" then " (<source>)" only when source is non-empty. HH:MM is the 24-hour time taken from the ISO string (characters 11–16, no timezone conversion). Separators are " · " (middle dot with spaces). Marks: done → "✓ finished", error → "✗ failed", stopped or cancelled → "■ stopped". An empty agent name becomes "agent".', why: 'The experience digest and briefs parse these exact headers; any other format is invisible to them.' },
  ] }],
  total: JOURNAL.length,
  score: (code) => runCases(code, 'journalHeader', JOURNAL),
};

// ---------- Task 3: ISO week numbers (technique: the Thursday rule; year-boundary edge cases) ----------
function refIsoWeek(s) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const DATES = ['2021-01-03', '2021-01-04', '2020-12-31', '2024-12-30', '2024-12-29', '2026-01-01', '2027-01-01', '2027-01-03', '2027-01-04', '2015-12-31', '2016-01-03', '2008-12-29', '2010-01-03', '2026-11-20', '2026-06-15', '2019-12-30', '2032-12-31', '2037-12-31', '2004-12-31', '2005-01-02'];
const ISO = DATES.map((d) => [[d], refIsoWeek(d)]);
const isoweek = {
  prompt: 'Write a JavaScript function `isoWeek(dateString)` that takes a date like "2026-11-20" and returns its ISO 8601 week as "YYYY-Www" (for example "2026-W47"). It must be correct at year boundaries and must not depend on the computer\'s timezone. Reply with only the code in one ```js block.',
  lessons: [{ topic: 'computing ISO 8601 week numbers in JavaScript', sources: ['Date bugs at New Year', 'ISO week explained'], techniques: [
    { name: 'Thursday rule for ISO weeks', when: 'computing an ISO 8601 week number or week-year for a date', do: 'Parse the date as UTC (Date.UTC(y, m-1, d)), never with new Date("YYYY-MM-DD") plus local getters. Take the weekday with Monday=1…Sunday=7 (getUTCDay() || 7), move the date to the Thursday of the same week (date + 4 − weekday). The ISO week-YEAR is that Thursday\'s UTC year (it can differ from the calendar year: 2021-01-03 is 2020-W53, 2024-12-30 is 2025-W01). Week = ceil(((thursday − Jan 1 of that year in days) + 1) / 7). Pad the week to 2 digits.', why: 'Every ISO week bug comes from using the calendar year at year boundaries or from local-timezone parsing.' },
  ] }],
  total: ISO.length,
  score: (code) => runCases(code, 'isoWeek', ISO),
};

module.exports = { semver, journal, isoweek };
