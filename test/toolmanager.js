'use strict';
// Universal AI tool manager (#15): reads each AI app's MCP servers, never exposes secret values, shares a server
// from one app to others without overwriting your own entries, removes only what it added, health-checks servers
// with a real MCP handshake, and the Settings panel works.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')); const H = path.join(T, 'home'); process.env.CORTEX_TOOLS_HOME = H; process.env.APPDATA = path.join(H, 'AppData', 'Roaming');
  const tm = require('../src/toolmanager'); const A = tm.apps();
  // a real (tiny) MCP server over stdio
  const srvFile = path.join(T, 'mcp-server.js');
  fs.writeFileSync(srvFile, `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}
if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'weather-mcp',version:'1'}}}));
if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'forecast'},{name:'alerts'}]}}));}});`);
  fs.mkdirSync(path.dirname(A.cursor.file), { recursive: true });
  fs.writeFileSync(A.cursor.file, JSON.stringify({ mcpServers: { weather: { command: process.execPath, args: [srvFile], env: { WEATHER_API_KEY: 'super-secret-value-123' } }, docs: { url: 'https://docs.example.com/mcp?api_key=abc123secret' } } }, null, 2));
  fs.mkdirSync(A.claudeDesktop.dir, { recursive: true });
  fs.writeFileSync(A.claudeDesktop.file, JSON.stringify({ mcpServers: { mine: { command: 'my-own-server' } }, otherSetting: true }, null, 2));
  fs.mkdirSync(A.codex.dir, { recursive: true });
  fs.writeFileSync(A.codex.file, 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n\n[profiles.x]\nmodel = "o3"\n');
  const vault = path.join(T, 'v'); fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });

  const inv = tm.inventory(vault);
  assert.ok(inv.apps.cursor.installed && inv.apps.claudeDesktop.installed && inv.apps.codex.installed && !inv.apps.windsurf.installed);
  assert.deepEqual(Object.keys(inv.servers).sort(), ['docs', 'mine', 'weather']);
  assert.deepEqual(inv.servers.weather.in.cursor.env, ['WEATHER_API_KEY']);
  assert.equal(inv.servers.docs.variants, 2, 'same name, different setups is flagged');
  assert.ok(!JSON.stringify(inv).includes('super-secret-value-123') && !JSON.stringify(inv).includes('abc123secret'), 'secret values never appear (env, URL tokens)');
  assert.deepEqual(inv.servers.weather.canShareTo.sort(), ['claudeDesktop', 'codex']);
  ok('inventory: each app\'s MCP servers (JSON and TOML), installed apps, conflicts flagged; key values never shown');

  const r = tm.share(vault, 'weather', 'cursor', ['claudeDesktop', 'codex', 'windsurf']);
  assert.deepEqual(r.map((x) => [x.app, x.ok]), [['claudeDesktop', true], ['codex', true], ['windsurf', false]]);
  const desk = JSON.parse(fs.readFileSync(A.claudeDesktop.file, 'utf8'));
  assert.ok(desk.mcpServers.weather && desk.mcpServers.mine && desk.otherSetting === true, 'added next to your own entries; other settings untouched');
  assert.ok(fs.existsSync(A.claudeDesktop.file + '.cortex-backup'), 'backup before the first change');
  const toml = fs.readFileSync(A.codex.file, 'utf8');
  assert.ok(toml.includes('[mcp_servers.weather]') && toml.includes('[profiles.x]') && toml.includes('model = "gpt-5"'));
  assert.equal(tm.readToml(A.codex.file).weather.env.WEATHER_API_KEY, 'super-secret-value-123', 'the key is copied app-to-app (it has to be, for the app to work)');
  assert.ok(!fs.readFileSync(path.join(vault, '.cortex', 'tools.json'), 'utf8').includes('super-secret'), 'Cortex keeps no copy of the key');
  const dup = tm.share(vault, 'docs', 'cursor', ['codex']); assert.equal(dup[0].ok, false); assert.match(dup[0].msg, /already has a different "docs"/);
  assert.match(tm.readToml(A.codex.file).docs.command, /npx/, 'your own entry is never overwritten');
  ok('share: copies a server into other apps next to your own entries, backs up, never overwrites; Cortex stores no keys');

  assert.throws(() => tm.unshare(vault, 'mine', 'claudeDesktop'), /didn't add "mine"/);
  tm.unshare(vault, 'weather', 'codex');
  const t2 = fs.readFileSync(A.codex.file, 'utf8'); assert.ok(!t2.includes('mcp_servers.weather') && t2.includes('[mcp_servers.docs]') && t2.includes('[profiles.x]'));
  ok('remove: only servers Cortex added; your own entries can\'t be removed from here');

  const h = await tm.check('weather', 'cursor'); assert.ok(h.ok && h.tools === 2 && h.server === 'weather-mcp', JSON.stringify(h));
  fs.writeFileSync(A.cursor.file, JSON.stringify({ mcpServers: { broken: { command: path.join(T, 'nope') }, dead: { command: process.execPath, args: ['-e', 'process.exit(3)'] } } }));
  assert.match((await tm.check('broken', 'cursor')).error, /Program not found/);
  assert.match((await tm.check('dead', 'cursor')).error, /stopped straight away/);
  ok('health check: real MCP handshake lists the tools; missing or crashing servers explained');

  const lt = tm.localTools(); assert.ok(lt.tools.find((t) => t.bin === 'node').found); assert.ok(lt.apiKeys.every((k) => typeof k.set === 'boolean' && !('value' in k)));

  // server + Settings panel
  fs.writeFileSync(A.cursor.file, JSON.stringify({ mcpServers: { weather: { command: process.execPath, args: [srvFile], env: { WEATHER_API_KEY: 'super-secret-value-123' } } } }));
  const port = 45900 + Math.floor(Math.random() * 90);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', vault, '--port', String(port)], { stdio: 'ignore', env: { ...process.env } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  try {
    const g = await fetch(base + '/api/tools'); const gt = await g.text(); assert.equal(g.status, 200); assert.ok(!gt.includes('super-secret'));
    let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* none */ }
    if (!chromium) console.log('  (no browser available: skipping the page check)');
    else {
      const browser = await chromium.launch();
      try {
        const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
        await page.addInitScript(() => { try { localStorage.setItem('cortex.tourDone', '1'); } catch { /* private */ } });
        page.on('dialog', (d) => d.accept());
        await page.goto(base + '/#/settings'); await page.waitForSelector('#tm-set [data-tm-check]');
        await page.click('#tm-set [data-tm-check="weather"]'); await page.waitForSelector('#tm-set .tm-res.ok'); assert.match(await page.locator('#tm-set .tm-res.ok').innerText(), /2 tools/);
        await page.click('#tm-set [data-tm-share]'); await page.waitForFunction(() => document.querySelector('#tm-set [data-tm-un]'));
        assert.ok(JSON.parse(fs.readFileSync(A.claudeDesktop.file, 'utf8')).mcpServers.weather);
        assert.ok(!(await page.content()).includes('super-secret'), 'the page never contains key values');
        assert.deepEqual(errs, []);
      } finally { await browser.close(); }
      ok('Settings panel: check a tool, share it with one click, remove what Cortex added; no key values on the page');
    }
  } finally { srv.kill(); await sleep(200); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} tool manager checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
