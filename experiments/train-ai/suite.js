'use strict';
// Train AI 5x protocol: the FROZEN 10-task suite (written before round 0, never changed between rounds).
// Every task needs knowledge that lives in the user's Cortex (project notes, lessons), not in the model.
// Hidden tests live only here. Never copy test cases or expected outputs into lessons or notes.
// A task-trial PASSES only when every hidden case passes.
const { journal } = require('./tasks');
const vm = require('vm');

function load(code, fnName) {
  const sandbox = { module: { exports: {} }, exports: {}, console: { log() {} }, encodeURIComponent, decodeURIComponent, URL };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\n;this.__fn = typeof ${fnName} !== 'undefined' ? ${fnName} : (module.exports.${fnName} || module.exports);`, sandbox, { timeout: 2000 });
  if (typeof sandbox.__fn !== 'function') throw new Error(`no function ${fnName}`);
  return sandbox.__fn;
}
// cases: [args, want] or [args, checkFn(got) -> boolean]
function runCases(code, fnName, cases) {
  let fn;
  try { fn = load(code, fnName); } catch (e) { return { passed: 0, total: cases.length, failures: ['does not load: ' + e.message.slice(0, 120)] }; }
  let passed = 0;
  const failures = [];
  for (const [args, want] of cases) {
    let got;
    try { got = fn(...JSON.parse(JSON.stringify(args))); } catch (e) { got = 'THROWS ' + e.message; }
    const ok = typeof want === 'function' ? (() => { try { return !!want(got); } catch { return false; } })() : JSON.stringify(got) === JSON.stringify(want);
    if (ok) passed++;
    else if (failures.length < 6) failures.push(`${JSON.stringify(args).slice(0, 120)} → ${JSON.stringify(got).slice(0, 160)}`);
  }
  return { passed, total: cases.length, failures };
}
const ONLY_CODE = ' Reply with only the code in one ```js block.';
const task = (id, project, fn, prompt, cases) => ({ id, project, fn, prompt: prompt + ONLY_CODE, total: cases.length, score: (code) => runCases(code, fn, cases) });

// 1. Cortex journal header (from tasks.js, unchanged hidden tests)
const t1 = { id: 'journal', project: 'cortex', fn: 'journalHeader', prompt: journal.prompt, total: journal.total, score: journal.score };

// 2. SkyBlock: port a Java line to Minecraft 26.2
const t2 = task('port262', 'skyblock-macros', 'port262',
  'For the user\'s SkyBlock macros project (a Fabric client mod), write a JavaScript function `port262(line)` that takes one line of the mod\'s Java source written for Minecraft 26.1 and returns it updated for the Minecraft 26.2 API, following the API changes recorded for this project. Only change what 26.2 renamed or moved; leave everything else exactly as it was.',
  [
    [['ResourceLocation id = new ResourceLocation("skyblock", "dash");'], 'Identifier id = new Identifier("skyblock", "dash");'],
    [['if (mc.screen == null) mc.setScreen(new Dashboard());'], 'if (mc.gui.screen() == null) mc.gui.setScreen(new Dashboard());'],
    [['Screen current = mc.screen;'], 'Screen current = mc.gui.screen();'],
    [['mc.setScreen(null);'], 'mc.gui.setScreen(null);'],
    [['private static final ResourceLocation ICON = ResourceLocation.parse("skyblock:icon");'], 'private static final Identifier ICON = Identifier.parse("skyblock:icon");'],
    [['int routeCount = routes.size();'], 'int routeCount = routes.size();'],
  ]);

// 3. SkyBlock: which features does this project build?
const FEATS = { 'route-checker': true, 'route-preview-overlay': true, 'guided-waypoint': true, 'stats-hud': true, 'readiness-check': true, 'tool-advisor': true, diagnostics: true,
  'auto-route-follow': false, 'auto-mining': false, 'powder-grinder': false, 'watchdog-detection': false, 'input-randomisation': false, 'slayer-automation': false, 'bazaar-order-engine': false, 'commission-automation': false };
const t3 = task('scope', 'skyblock-macros', 'isInScope',
  `For the user's SkyBlock macros project, write a JavaScript function \`isInScope(feature)\` that returns true if the project currently builds that feature and false if it is out of scope, following the project's current scope decision. \`feature\` is one of: ${Object.keys(FEATS).map((f) => `"${f}"`).join(', ')}.`,
  Object.entries(FEATS).map(([f, v]) => [[f], v]));

// 4. Roblox: mesh import plan (house rule: triangle cap and decimation target)
// (replaced "udim" before round 0: Haiku passed it with an empty Cortex in the pilot)
const t4 = task('mesh', 'roblox-games', 'meshPlan',
  'For the user\'s Roblox games, write a JavaScript function `meshPlan(triangles)` that decides what to do with a 3D model (for example an image-to-3D model from Blender) before importing it into Roblox Studio, following the user\'s Roblox rules for meshes. Return `{ action: "import" }` if it can be imported as is, otherwise `{ action: "decimate", min, max }` with the triangle range to decimate it to.',
  [
    [[5000], { action: 'import' }],
    [[20000], { action: 'import' }],
    [[20001], { action: 'decimate', min: 6000, max: 10000 }],
    [[600000], { action: 'decimate', min: 6000, max: 10000 }],
  ]);

// 5. Roblox: RemoteFunction handler code (house rule: named local function)
const handlerOk = (remote, fn) => (s) => typeof s === 'string'
  && new RegExp(`local\\s+function\\s+${fn}\\s*\\(\\s*player\\b`).test(s)
  && new RegExp(`${remote.replace('.', '\\.')}\\.OnServerInvoke\\s*=\\s*${fn}\\s*($|\\n|;|--)`, 'm').test(s)
  && !/OnServerInvoke\s*=\s*function/.test(s);
const t5 = task('invoke', 'roblox-games', 'serverInvokeCode',
  'For the user\'s Roblox games, write a JavaScript function `serverInvokeCode(remoteVar, handlerName, bodyLua)` that returns the Luau server code that answers a RemoteFunction (the variable `remoteVar`), following the user\'s Roblox scripting rules. The handler receives `player` first, then the arguments; `bodyLua` is the handler body. Return the code as a string.',
  [
    [['buyRemote', 'buyItem', 'return true'], handlerOk('buyRemote', 'buyItem')],
    [['Remotes.Launch', 'launchMissile', 'return fire(player)'], handlerOk('Remotes.Launch', 'launchMissile')],
    [['ascendFn', 'doAscend', 'local ok = ascend(player)\nreturn ok'], handlerOk('ascendFn', 'doAscend')],
  ]);

// 6. Roblox: publishing requirements per audience (May 2026 tiers)
const t6 = task('publish', 'roblox-games', 'publishRequirements',
  'For the user\'s Roblox games, write a JavaScript function `publishRequirements(audience)` that returns what the account owner must have before publishing a game for that audience under Roblox\'s current publishing tiers. `audience` is "personal", "16+", "trusted-friends" or "all-ages". Return an alphabetically sorted array using only these codes: "2-step-verification", "age-check", "id-verification", "roblox-plus".',
  [
    [['personal'], []],
    [['16+'], ['age-check']],
    [['trusted-friends'], ['age-check']],
    [['all-ages'], ['2-step-verification', 'age-check', 'id-verification', 'roblox-plus']],
  ]);

// 7. Cortex: phone pairing link
const t7 = task('pairing', 'cortex', 'pairingLink',
  'For Cortex (the user\'s AI project manager), write a JavaScript function `pairingLink(baseUrl, token)` that returns the full link a phone opens the first time to pair with Cortex and land on the right screen. `baseUrl` is Cortex\'s public address with no trailing slash (for example "https://pc.example.ts.net"); `token` is the pairing token.',
  [
    [['https://home.example.ts.net', 'abc123'], 'https://home.example.ts.net/?token=abc123#/live'],
    [['http://10.0.0.5:7777', 'Zz9-x'], 'http://10.0.0.5:7777/?token=Zz9-x#/live'],
    [['https://pc.example.ts.net', 'a b&c'], 'https://pc.example.ts.net/?token=a%20b%26c#/live'],
  ]);

// 8. Cortex: backup file name for a config file Cortex changes
// (replaced "local", then "connector", before round 0: Haiku passed both with an empty Cortex in the pilots)
const t8 = task('backup', 'cortex', 'backupPath',
  'For Cortex (the user\'s AI project manager), write a JavaScript function `backupPath(filePath)` that returns the path of the backup copy Cortex keeps when it changes one of the user\'s config files (for example Claude Code\'s settings.json or a CLAUDE.md), following Cortex\'s rules.',
  [
    [['C:/Users/u/.claude/settings.json'], 'C:/Users/u/.claude/settings.json.cortex-backup'],
    [['/home/u/.claude/CLAUDE.md'], '/home/u/.claude/CLAUDE.md.cortex-backup'],
    [['/home/u/project/AGENTS.md'], '/home/u/project/AGENTS.md.cortex-backup'],
  ]);

// 9. Cortex: what happens to an update
const t9 = task('update', 'cortex', 'updateOutcome',
  'For Cortex (the user\'s AI project manager), write a JavaScript function `updateOutcome({ supervised, uptimeSec, crashed })` that says what Cortex\'s updater does with a newly installed version. `supervised` says whether Cortex runs under its supervisor, `uptimeSec` is how long the new version has been running, `crashed` says whether it has crashed so far. Return one of "not-applied", "pending", "confirmed", "rolled-back".',
  [
    [[{ supervised: false, uptimeSec: 100, crashed: false }], 'not-applied'],
    [[{ supervised: true, uptimeSec: 9, crashed: false }], 'confirmed'],
    [[{ supervised: true, uptimeSec: 60, crashed: false }], 'confirmed'],
    [[{ supervised: true, uptimeSec: 7.5, crashed: false }], 'pending'],
    [[{ supervised: true, uptimeSec: 0, crashed: false }], 'pending'],
    [[{ supervised: true, uptimeSec: 3, crashed: true }], 'rolled-back'],
  ]);

// 10. Cortex: may Cortex overwrite a skill folder?
const t10 = task('skills', 'cortex', 'mayOverwriteSkill',
  'For Cortex (the user\'s AI project manager), write a JavaScript function `mayOverwriteSkill(fileNames)` that decides, following Cortex\'s rules for skills, whether Cortex may overwrite or remove an existing skill folder. `fileNames` lists the files in that folder. Return true or false.',
  [
    [[['SKILL.md', '.cortex-managed']], true],
    [[['.cortex-managed', 'SKILL.md', 'notes.md']], true],
    [[['SKILL.md']], false],
    [[['SKILL.md', 'cortex-managed']], false],
    [[['SKILL.md', 'README.md']], false],
  ]);

const SUITE = [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10];
module.exports = { SUITE, runCases };
