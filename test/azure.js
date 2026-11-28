'use strict';
// Cortex on Azure (App Service + Cosmos DB + Key Vault settings): a fake Cosmos DB REST API and a fake App Service
// managed-identity endpoint stand in for Azure. Checks: no-dependency Cosmos client with Entra tokens and throttling
// retries; the vault survives restarts through Cosmos (big files in parts, appends rewrite only two parts, deletions);
// owner pairing with the Key Vault setup code; owners can do main-computer things, other phones can't; /healthz; and
// computers keep a two-way synced copy (first sync uploads the vault, conflicts keep both, .cortex stays local).
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const { Cosmos } = require('../src/azure/cosmos');
const persist = require('../src/azure/persist');
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeAzure() {
  const docs = new Map(); const stats = { upserts: 0, deletes: 0, queries: 0, throttled: 0, badAuth: 0, tokens: 0 }; let throttleNext = 0;
  const TOKEN = 'fake-entra-token-' + Date.now();
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }).on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/msi') { // App Service managed identity endpoint
        if (req.headers['x-identity-header'] !== 'fake-header' || u.searchParams.get('resource') !== 'https://cosmos.azure.com') { res.writeHead(400); return res.end('{}'); }
        stats.tokens++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ access_token: TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
      }
      if (decodeURIComponent(req.headers.authorization || '') !== `type=aad&ver=1.0&sig=${TOKEN}`) { stats.badAuth++; res.writeHead(401); return res.end('{"message":"bad token"}'); }
      if (throttleNext > 0) { throttleNext--; stats.throttled++; res.writeHead(429, { 'x-ms-retry-after-ms': '20' }); return res.end('{}'); }
      const m = u.pathname.match(/^\/dbs\/([^/]+)\/colls\/([^/]+)\/docs(?:\/(.+))?$/); if (!m) { res.writeHead(404); return res.end('{}'); }
      const pk = req.headers['x-ms-documentdb-partitionkey'] ? JSON.parse(req.headers['x-ms-documentdb-partitionkey'])[0] : null;
      const key = (id, p) => `${m[2]}|${p}|${id}`;
      const send = (code, j, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'x-ms-request-charge': '5.0', ...h }); res.end(JSON.stringify(j)); };
      if (req.method === 'POST' && req.headers['x-ms-documentdb-isquery']) {
        stats.queries++; const all = [...docs.entries()].filter(([k]) => k.startsWith(m[2] + '|')).map(([, d]) => d);
        const start = Number(req.headers['x-ms-continuation'] || 0); const page = all.slice(start, start + 7); // small pages: continuation is exercised
        return send(200, { Documents: page, _count: page.length }, start + 7 < all.length ? { 'x-ms-continuation': String(start + 7) } : {});
      }
      if (req.method === 'POST') { const d = JSON.parse(body); if (d.area !== pk) return send(400, { message: 'partition key mismatch' }); docs.set(key(d.id, pk), d); stats.upserts++; return send(200, d); }
      const id = decodeURIComponent(m[3] || '');
      if (req.method === 'GET') { const d = docs.get(key(id, pk)); return d ? send(200, d) : send(404, { code: 'NotFound' }); }
      if (req.method === 'DELETE') { const had = docs.delete(key(id, pk)); stats.deletes++; return had ? send(204, {}) : send(404, { code: 'NotFound' }); }
      send(405, {});
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, docs, stats, throttle: (n) => { throttleNext = n; } })));
}

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'az-'));
  const az = await fakeAzure();
  const env = { ...process.env, IDENTITY_ENDPOINT: `${az.url}/msi`, IDENTITY_HEADER: 'fake-header' };
  const { identityTokenSource } = require('../src/azure/cosmos');
  const cosmos = new Cosmos({ endpoint: az.url, database: 'cortex', tokenSource: identityTokenSource({ env }) });
  // ---------- client ----------
  await cosmos.upsert('vault', { id: 'a', area: 'notes', path: 'notes/a.md', part: 0, parts: 1, data: '' }, 'notes');
  assert.equal((await cosmos.read('vault', 'a', 'notes')).path, 'notes/a.md');
  az.throttle(2); await cosmos.upsert('vault', { id: 'b', area: 'notes', path: 'notes/b.md' }, 'notes'); assert.equal(az.stats.throttled, 2, 'throttled requests are retried');
  assert.equal((await cosmos.query('vault', 'SELECT * FROM c')).length, 2);
  assert.ok(await cosmos.delete('vault', 'a', 'notes')); assert.equal(await cosmos.read('vault', 'a', 'notes'), null);
  await cosmos.delete('vault', 'b', 'notes');
  assert.equal(az.stats.tokens, 1, 'the identity token is cached'); assert.equal(az.stats.badAuth, 0);
  await assert.rejects(() => new Cosmos({ endpoint: az.url, tokenSource: identityTokenSource({ env: {} }) }).query('vault', 'SELECT * FROM c'), /No managed identity/);
  ok('Cosmos client: Entra token from the managed identity (cached), upsert/read/query with paging/delete, throttling retried; no npm packages');

  // ---------- persistence ----------
  const v1 = path.join(T, 'v1'); const st1 = new Store(v1);
  const n1 = st1.create('note', { title: 'Azure plan', body: 'Cosmos + App Service' });
  fs.mkdirSync(path.join(v1, 'attachments'), { recursive: true }); fs.writeFileSync(path.join(v1, 'attachments', 'big.bin'), Buffer.alloc(persist.PART * 2 + 1000, 7));
  require('../src/settings').save(v1, require('../src/settings').load(v1));
  fs.writeFileSync(path.join(v1, '.cortex', 'x.lock'), 'pid'); fs.mkdirSync(path.join(v1, '.cortex', 'backups'), { recursive: true }); fs.writeFileSync(path.join(v1, '.cortex', 'backups', 'old.zip'), 'zip');
  const known = (await persist.hydrate(cosmos, v1)).known;
  await persist.push(cosmos, v1, known);
  const paths = new Set([...az.docs.values()].map((d) => d.path));
  assert.ok(paths.has(n1.id + '.md') && paths.has('attachments/big.bin') && paths.has('.cortex/settings.json'), 'notes, attachments and settings are saved: ' + [...paths].join(', '));
  assert.ok(!paths.has('.cortex/x.lock') && !paths.has('.cortex/backups/old.zip'), 'locks and local backups are not');
  assert.equal([...az.docs.values()].filter((d) => d.path === 'attachments/big.bin').length, 3, 'big files are stored in 512 KB parts');
  const before = az.stats.upserts; fs.appendFileSync(path.join(v1, 'attachments', 'big.bin'), 'more');
  await persist.push(cosmos, v1, known); assert.equal(az.stats.upserts - before, 2, 'an append rewrites only the first and last part');
  const v2 = path.join(T, 'v2'); const h2 = await persist.hydrate(cosmos, v2);
  assert.ok(h2.files >= 3 && fs.readFileSync(path.join(v2, n1.id + '.md'), 'utf8').includes('Cosmos + App Service'));
  assert.ok(fs.readFileSync(path.join(v2, 'attachments', 'big.bin')).equals(fs.readFileSync(path.join(v1, 'attachments', 'big.bin'))), 'restored byte for byte');
  fs.rmSync(path.join(v1, 'attachments', 'big.bin')); await persist.push(cosmos, v1, known);
  assert.ok(![...az.docs.values()].some((d) => d.path === 'attachments/big.bin'), 'deleted files are removed from Cosmos');
  const before2 = az.stats.upserts; await persist.push(cosmos, v1, known); assert.equal(az.stats.upserts, before2, 'nothing changed: nothing written');
  ok('persistence: restore everything on start, upload only what changed, big files in parts, appends cheap, deletions follow, locks/backups skipped');
  for (const k of [...az.docs.keys()]) az.docs.delete(k);

  // ---------- hosted server: restart safety, owner pairing, owner-only actions ----------
  const port = 44700 + Math.floor(Math.random() * 90);
  const OWNER = 'CX-test-owner-setup-code-123';
  const henv = (vault) => ({ ...env, CORTEX_STORE: 'cosmos', COSMOS_ENDPOINT: az.url, COSMOS_DATABASE: 'cortex', CORTEX_VAULT: vault, PORT: String(port), CORTEX_OWNER_SETUP_CODE: OWNER, CORTEX_CONNECTOR_TOKEN: 'conn-token-from-key-vault' });
  const startHosted = (vault) => spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve'], { env: henv(vault), stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`; const FWD = { 'X-Forwarded-For': '203.0.113.9' }; // like Azure's front end: never "this computer"
  const up = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) return true; } catch { /* starting */ } await sleep(250); } return false; };
  let h = startHosted(path.join(T, 'h1')); let logs = ''; h.stdout.on('data', (d) => { logs += d; }); h.stderr.on('data', (d) => { logs += d; });
  const req = (p, { method = 'GET', body, cookie } = {}) => fetch(base + p, { method, headers: { ...FWD, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let runnerHome = null;
  try {
    assert.ok(await up(), logs);
    const hz = await (await fetch(base + '/healthz')).json(); assert.ok(hz.ok && hz.hosted, 'health check needs no sign-in');
    assert.equal((await req('/api/state')).status, 401, 'nothing else without pairing');
    assert.equal((await req('/api/pair', { method: 'POST', body: { code: 'CX-wrong-code-0000000000' } })).status, 400);
    const pr = await req('/api/pair', { method: 'POST', body: { code: OWNER, name: 'My iPhone' } }); assert.equal(pr.status, 200);
    const owner = pr.headers.get('set-cookie').split(';')[0]; assert.ok((await pr.json()).device.owner, 'the setup code pairs the owner');
    assert.equal((await req('/api/pair', { method: 'POST', body: { code: OWNER } })).status, 400, 'the setup code works only for the first owner');
    const pc = await (await req('/api/devices/code', { method: 'POST', body: { kind: 'phone' }, cookie: owner })).json(); assert.ok(pc.code, 'owners can make pairing codes (a main-computer action)');
    const p2 = await req('/api/pair', { method: 'POST', body: { code: pc.code, name: 'Tablet' } }); const tablet = p2.headers.get('set-cookie').split(';')[0];
    assert.equal((await req('/api/devices/code', { method: 'POST', body: { kind: 'phone' }, cookie: tablet })).status, 403, 'other phones can\'t');
    assert.equal((await req('/api/state', { cookie: tablet })).status, 200);
    const t = await (await req('/api/items', { method: 'POST', body: { kind: 'task', title: 'Saved in Cosmos' }, cookie: owner })).json(); assert.ok(t.id);
    const s1 = await (await req('/api/settings', { cookie: owner })).json(); assert.equal(s1.connector && s1.connector.token, 'conn-token-from-key-vault', 'Key Vault settings are applied');
    ok('hosted: /healthz is public; the Key Vault setup code pairs the first owner only; owners can do main-computer actions, other phones can\'t');

    // computer sync: the home PC's existing vault goes up on the first sync
    const cc = await (await req('/api/devices/code', { method: 'POST', body: { kind: 'computer' }, cookie: owner })).json();
    runnerHome = path.join(T, 'runner'); process.env.CORTEX_RUNNER_HOME = runnerHome;
    const rc = require('../src/runner-client');
    const conf = await rc.pair({ hub: base, code: cc.code, name: 'Home PC' });
    const pcv = path.join(T, 'homepc'); const pst = new Store(pcv); const old = pst.create('note', { title: 'Years of notes', body: 'from the home PC' });
    fs.writeFileSync(path.join(pcv, '.cortex', 'devices.json'), '{"secret":"home-pc-key"}');
    await rc.syncOnce(conf, pcv);
    const st2 = await (await req('/api/state', { cookie: owner })).json();
    assert.ok(st2.notes.some((n) => n.title === 'Years of notes'), 'the first sync uploads the existing vault');
    assert.ok(fs.existsSync(path.join(pcv, t.id + '.md')), 'and brings down what was made in the cloud');
    assert.ok(!fs.readdirSync(pcv, { recursive: true }).some((f) => String(f).includes('(from Home PC)')), 'welcome notes that only differ in timestamps don\'t duplicate');
    await req('/api/items', { method: 'PATCH', body: { id: old.id, body: 'edited on the phone' }, cookie: owner });
    fs.writeFileSync(path.join(pcv, old.id + '.md'), fs.readFileSync(path.join(pcv, old.id + '.md'), 'utf8').replace('from the home PC', 'edited on the PC'));
    const extra = pst.create('note', { title: 'Delete me', body: 'x' }); await rc.syncOnce(conf, pcv);
    pst.scan(false); fs.rmSync(path.join(pcv, extra.id + '.md'));
    const r3 = await rc.syncOnce(conf, pcv);
    assert.ok(r3.deleted >= 1, 'the deletion was sent'); assert.ok(!(await (await req('/api/state', { cookie: owner })).json()).notes.some((n) => n.title === 'Delete me'), 'deletions sync');
    await rc.syncOnce(conf, pcv);
    const both = fs.readdirSync(path.join(pcv, path.dirname(old.id))).filter((f) => f.startsWith(path.basename(old.id)));
    assert.ok(both.length === 2, `edited in both places: both versions kept (${both.join(', ')})`);
    ok('computers: two-way sync with the cloud Cortex; first sync uploads the vault; deletions follow; edits on both sides keep both');

    // restart: everything comes back from Cosmos
    h.kill('SIGTERM'); await new Promise((r) => h.on('exit', r));
    h = startHosted(path.join(T, 'h2')); logs = ''; h.stdout.on('data', (d) => { logs += d; }); h.stderr.on('data', (d) => { logs += d; });
    assert.ok(await up(), logs);
    const st3 = await (await req('/api/state', { cookie: owner })).json();
    assert.ok(st3.tasks.some((x) => x.title === 'Saved in Cosmos') && st3.notes.some((n) => n.title === 'Years of notes'), 'tasks and notes survive a restart (fresh local disk)');
    assert.equal((await req('/api/devices/code', { method: 'POST', body: { kind: 'phone' }, cookie: owner })).status, 201, 'the owner\'s phone is still paired after the restart');
    assert.ok(![...az.docs.values()].some((d) => d.path === '.cortex/devices.json' && Buffer.from(d.data, 'base64').toString().includes('home-pc-key')), 'a computer\'s own .cortex never leaves it');
    ok('restart / redeploy: a fresh instance restores everything from Cosmos, including paired devices');
  } finally { h.kill('SIGTERM'); await sleep(300); az.srv.close(); fs.rmSync(T, { recursive: true, force: true }); }
  console.log(`All ${passed} Azure checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
