'use strict';
// SmartSave: autosave, backups and recovery. No AI calls anywhere in these tests.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { SmartSave } = require('../src/smartsave');
const { Repo } = require('../src/smartsave/repo');
const { S3Target, FolderTarget } = require('../src/smartsave/targets');
const { usageCrossing } = require('../src/smartsave/service');

let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ss-'));
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const treeHash = (root, rels) => Object.fromEntries(rels.map((r) => [r, sha(fs.readFileSync(path.join(root, r)))]));
function mk(name, extra = {}) {
  const proj = path.join(T, name);
  const cfg = { enabled: true, projects: { [name]: { enabled: true, root: proj } }, targets: [], ...extra };
  const ss = new SmartSave({ home: path.join(T, name + '-home'), config: () => cfg, device: 'pc-a' });
  return { proj, cfg, ss };
}

(async () => {
  // ---------- incremental, dedup, deletions ----------
  {
    const { proj, ss } = mk('inc');
    w(proj, 'src/a.js', 'same'); w(proj, 'src/b.js', 'same'); w(proj, 'README.md', '# hi');
    const r1 = ss.checkpoint('inc');
    assert.equal(r1.files, 3); assert.equal(ss.repo.objectIds().length, 2, 'identical files stored once');
    assert.ok(ss.checkpoint('inc').unchanged, 'nothing changed → no new checkpoint');
    w(proj, 'src/a.js', 'changed'); fs.unlinkSync(path.join(proj, 'README.md')); fs.renameSync(path.join(proj, 'src/b.js'), path.join(proj, 'src/c.js'));
    const r3 = ss.checkpoint('inc');
    assert.equal(r3.changed, 1); assert.equal(r3.deleted, 2); assert.equal(r3.added, 1);
    assert.equal(ss.repo.objectIds().length, 3, 'only the changed content is new (rename reuses content)');
    assert.equal(ss.snapshots('inc').length, 2);
    ok('incremental: unchanged files are not re-read, identical content stored once, changes/deletions/renames recorded');
  }

  // ---------- privacy: secrets, ignores, links ----------
  {
    const { proj, ss } = mk('priv');
    w(proj, 'app.js', 'ok'); w(proj, '.env', 'API=1'); w(proj, '.env.example', 'API='); w(proj, '.ssh/id_ed25519', 'k'); w(proj, 'deploy/id_rsa', 'k');
    w(proj, 'certs/site.pem', 'k'); w(proj, 'config/credentials.json', '{}'); w(proj, 'notes.md', 'token ghp_' + 'a'.repeat(36));
    w(proj, 'keys.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'); w(proj, 'node_modules/x/i.js', 'x'); w(proj, 'dist/out.js', 'x');
    w(proj, '.gitignore', 'logs/\n*.tmp\n!keep.tmp\n'); w(proj, 'logs/a.log', 'x'); w(proj, 'a.tmp', 'x'); w(proj, 'keep.tmp', 'keep');
    const outside = path.join(T, 'outside-secret.txt'); fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(proj, 'link.txt')); fs.symlinkSync(T, path.join(proj, 'linkdir'));
    const r = ss.checkpoint('priv');
    const saved = ss.repo.getSnapshot('priv', r.snapshot).files.map((f) => f.path).sort();
    assert.deepEqual(saved, ['.env.example', '.gitignore', 'app.js', 'keep.tmp']);
    const pv = ss.preview('priv');
    assert.ok(pv.skipped.some((x) => x.path === 'notes.md' && /GitHub token/.test(x.reason)));
    assert.ok(pv.skipped.some((x) => x.path === 'link.txt' && /link/.test(x.reason)));
    ok('never saves .env, keys, certs, credential folders, files with tokens/private keys, ignored or dependency files, or links');
  }

  // ---------- corruption ----------
  {
    const { proj, ss } = mk('corrupt');
    w(proj, 'a.txt', 'aaaa'); w(proj, 'b.txt', 'bbbb');
    const r = ss.checkpoint('corrupt');
    const m = ss.repo.getSnapshot('corrupt', r.snapshot);
    const bad = m.files.find((f) => f.path === 'a.txt');
    const f = ss.repo.objPath(bad.id); const buf = fs.readFileSync(f); buf[buf.length - 3] ^= 0xff; fs.writeFileSync(f, buf);
    assert.throws(() => ss.repo.get(bad.id), /integrity|corrupt/);
    const v = ss.repo.verifySnapshot('corrupt', r.snapshot);
    assert.equal(v.ok, false); assert.equal(v.bad.length, 1);
    const res = ss.restore('corrupt', r.snapshot, { dest: path.join(T, 'corrupt-out') });
    assert.equal(res.failed.length, 1); assert.equal(fs.readFileSync(path.join(T, 'corrupt-out', 'b.txt'), 'utf8'), 'bbbb');
    assert.ok(!fs.existsSync(path.join(T, 'corrupt-out', 'a.txt')), 'a corrupted file is never written as if it were good');
    fs.writeFileSync(ss.repo.snapPath('corrupt', 'zzzzzzzz-bad'), 'garbage');
    assert.ok(ss.snapshots('corrupt').some((x) => x.corrupt));
    assert.ok(ss.repo.gc({ dryRun: true }).skipped, 'cleanup refuses to delete anything while a snapshot is unreadable');
    // a manifest can never be published before its objects exist
    assert.throws(() => ss.repo.putSnapshot({ ...m, id: 'x1', files: [{ path: 'z', id: 'f'.repeat(64), size: 1 }] }), /objects missing/);
    ok('corruption is detected (authenticated encryption + id check); bad files are reported, never restored; cleanup stays safe');
  }

  // ---------- path traversal on restore ----------
  {
    const { proj, ss } = mk('trav');
    w(proj, 'ok.txt', 'ok');
    ss.checkpoint('trav');
    const id = ss.repo.put(Buffer.from('evil')).id;
    ss.repo.putSnapshot({ v: 1, id: 'zz-evil', workspace: 'trav', time: new Date().toISOString(), files: [{ path: '../escaped.txt', id, size: 4 }, { path: '/etc/x', id, size: 4 }, { path: 'C:\\x', id, size: 4 }], deleted: [] });
    const dest = path.join(T, 'trav-out');
    const r = ss.restore('trav', 'zz-evil', { dest });
    assert.equal(r.written, 0); assert.equal(r.failed.length, 3);
    assert.ok(!fs.existsSync(path.join(T, 'escaped.txt')));
    ok('restore refuses paths that would escape the restore folder');
  }

  // ---------- restore never overwrites silently ----------
  {
    const { proj, ss } = mk('safe');
    w(proj, 'a.txt', 'v1'); const r1 = ss.checkpoint('safe');
    const dest = path.join(T, 'safe-out'); w(dest, 'a.txt', 'my newer edit');
    const d = ss.diff('safe', r1.snapshot, dest);
    assert.deepEqual(d.change, ['a.txt']);
    const r = ss.restore('safe', r1.snapshot, { dest });
    assert.deepEqual(r.conflicts, ['a.txt']); assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'my newer edit');
    const r2 = ss.restore('safe', r1.snapshot, { dest, overwrite: true });
    assert.equal(r2.written, 1); assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'v1');
    assert.ok(fs.readFileSync(path.join(dest, 'CORTEX-RESTORE.md'), 'utf8').includes('Restored by Cortex SmartSave'));
    ok('restore previews differences and never overwrites a different file unless you allow it');
  }

  // ---------- locked file, full disk ----------
  {
    const { proj, ss } = mk('lockd');
    w(proj, 'a.txt', 'one'); w(proj, 'b.txt', 'two'); ss.checkpoint('lockd');
    w(proj, 'a.txt', 'one changed'); w(proj, 'b.txt', 'two changed');
    const real = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) { if (String(p).endsWith(path.join('lockd', 'a.txt'))) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return real.call(this, p, ...rest); };
    let r; try { r = ss.checkpoint('lockd'); } finally { fs.readFileSync = real; }
    const m = ss.repo.getSnapshot('lockd', r.snapshot);
    assert.ok(m.files.some((f) => f.path === 'a.txt'), 'a locked file keeps its previous version (not dropped)');
    assert.ok(m.skipped.some((x) => x.path === 'a.txt' && /locked/.test(x.reason)));
    const before = ss.snapshots('lockd').length;
    w(proj, 'c.txt', 'new');
    const realW = fs.writeSync;
    fs.writeSync = function (fd, buf, ...rest) { if (Buffer.isBuffer(buf) && buf.length > 20) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } return realW.call(this, fd, buf, ...rest); };
    try { assert.throws(() => ss.checkpoint('lockd'), /no space/); } finally { fs.writeSync = realW; }
    assert.equal(ss.snapshots('lockd').length, before, 'a full disk publishes nothing half-written');
    assert.ok(ss.checkpoint('lockd').snapshot, 'and the next save works once there is space');
    for (const v of ss.snapshots('lockd')) assert.ok(ss.repo.verifySnapshot('lockd', v.id).ok);
    ok('locked files keep their last good version; a full disk leaves earlier saves intact and the next save recovers');
  }

  // ---------- concurrency + sudden kill ----------
  {
    const { proj, cfg } = mk('kill');
    for (let i = 0; i < 1500; i++) w(proj, `src/f${i}.txt`, crypto.randomBytes(2048));
    const home = path.join(T, 'kill-home');
    const a = new SmartSave({ home, config: () => cfg }); const b = new SmartSave({ home, config: () => cfg });
    const lockf = path.join(home, 'lock'); fs.writeFileSync(lockf, String(process.pid));
    assert.throws(() => b.checkpoint('kill'), (e) => e.code === 'BUSY', 'a second writer waits its turn');
    fs.rmSync(lockf);
    a.checkpoint('kill');
    // kill a saving process at random moments, several times; every published snapshot must stay intact
    const script = `const {SmartSave}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'smartsave'))});const cfg=${JSON.stringify(cfg)};const ss=new SmartSave({home:${JSON.stringify(home)},config:()=>cfg});const fs=require('fs');for(let i=0;i<1500;i+=3)fs.appendFileSync(${JSON.stringify(proj)}+'/src/f'+i+'.txt','x'+Date.now());ss.checkpoint('kill',{reason:'child'});`;
    for (let k = 0; k < 4; k++) {
      const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      await sleep(80 + k * 60); c.kill('SIGKILL'); await new Promise((r) => c.on('exit', r));
    }
    const after = new SmartSave({ home, config: () => cfg });
    const r = after.checkpoint('kill', { reason: 'after crashes' });
    assert.ok(r.snapshot || r.unchanged, 'a lock left by a killed process does not block saving');
    for (const s of after.snapshots('kill', { limit: 100 })) assert.ok(!s.corrupt && after.repo.verifySnapshot('kill', s.id).ok, 'snapshot ' + s.id + ' intact');
    const last = after.snapshots('kill')[0];
    const out = path.join(T, 'kill-restore');
    after.restore('kill', last.id, { dest: out });
    const rels = after.repo.getSnapshot('kill', last.id).files.map((f) => f.path);
    assert.deepEqual(treeHash(out, rels), treeHash(proj, rels), 'restored bytes match the project exactly');
    ok('saving processes killed mid-write (4 times) leave no broken snapshot; the latest restores byte-for-byte');
  }

  // ---------- network interruptions with an S3-compatible target ----------
  {
    const store = new Map(); let failNext = 0; let drop = 0; let seenSig = 0;
    const srv = http.createServer((req, res) => {
      if (/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/.test(req.headers.authorization || '')) seenSig++;
      if (drop > 0) { drop--; req.socket.destroy(); return; }
      if (failNext > 0) { failNext--; res.writeHead(503); return res.end('slow down'); }
      const u = new URL(req.url, 'http://x'); const key = decodeURIComponent(u.pathname);
      if (req.method === 'PUT') { const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => { store.set(key, Buffer.concat(ch)); res.end(); }); return; }
      if (req.method === 'HEAD') { res.writeHead(store.has(key) ? 200 : 404); return res.end(); }
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') { const pre = '/bkt/' + u.searchParams.get('prefix'); res.end(`<x>${[...store.keys()].filter((k) => k.startsWith(pre)).map((k) => `<Key>${k.slice(5)}</Key>`).join('')}</x>`); return; }
      if (req.method === 'GET') { if (!store.has(key)) { res.writeHead(404); return res.end(); } return res.end(store.get(key)); }
      res.writeHead(405); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${srv.address().port}`;
    const { proj, ss, cfg } = mk('net', { targets: [{ id: 's3', type: 's3', name: 'R2', endpoint, bucket: 'bkt', region: 'auto', accessKeyId: 'AK' }] });
    ss.setSecret('s3', 'SECRET');
    for (let i = 0; i < 30; i++) w(proj, `f${i}.txt`, 'file ' + i);
    const r1 = ss.checkpoint('net');
    assert.equal(ss.status().projects.net.targets[0].state, 'queued', 'saved locally, upload pending: shown separately');
    drop = 1;
    let u = await ss.uploadPending();
    assert.equal(u.failed, 1);
    let st = ss.status().projects.net;
    assert.equal(st.targets[0].state, 'failed'); assert.ok(st.targets[0].error); assert.equal(st.protection, 'failing');
    assert.ok(st.lastLocal && !st.lastProtected, 'locally saved but NOT yet protected');
    u = await ss.uploadPending(); assert.equal(u.uploaded, 0, 'backs off instead of hammering a failing server');
    const s0 = ss.state(); s0.targets.s3.nextTry = 0; ss.saveState(s0); failNext = 1;
    u = await ss.uploadPending(); assert.equal(u.failed, 1, 'a 503 is a failure too');
    const s1 = ss.state(); s1.targets.s3.nextTry = 0; ss.saveState(s1);
    u = await ss.uploadPending();
    assert.equal(u.uploaded, 1);
    st = ss.status().projects.net;
    assert.equal(st.targets[0].state, 'verified'); assert.equal(st.protection, 'protected'); assert.ok(st.lastProtected);
    const objs = [...store.keys()].filter((k) => k.includes('/objects/')).length;
    w(proj, 'f0.txt', 'edited'); ss.checkpoint('net'); await ss.uploadPending();
    assert.equal([...store.keys()].filter((k) => k.includes('/objects/')).length, objs + 1, 'retries and new saves upload only what is missing');
    assert.ok(seenSig > 0, 'requests are SigV4-signed');
    assert.ok(![...store.values()].some((b) => b.includes(Buffer.from('file 1'))), 'only encrypted data leaves the computer');
    // restore on a NEW computer from cloud storage, with the recovery key, while the original is gone
    const key = ss.recoveryKey();
    const fresh = new SmartSave({ home: path.join(T, 'net-newpc'), key: SmartSave.parseRecoveryKey(key), config: () => ({ ...cfg, projects: {} }) });
    const ids = (await new S3Target({ endpoint, bucket: 'bkt', accessKeyId: 'AK', secretAccessKey: 'SECRET' }).list('snapshots/net/')).map((k) => k.split('/').pop().replace('.json', '')).sort().reverse();
    await fresh.fetchFrom(new S3Target({ endpoint, bucket: 'bkt', accessKeyId: 'AK', secretAccessKey: 'SECRET' }), 'net', ids[ids.length - 1]);
    const out = path.join(T, 'net-restored'); const rr = fresh.restore('net', r1.snapshot, { dest: out });
    assert.equal(rr.verified, 30); assert.equal(fs.readFileSync(path.join(out, 'f1.txt'), 'utf8'), 'file 1');
    const wrong = new SmartSave({ home: path.join(T, 'net-wrongkey'), config: () => ({}) });
    await assert.rejects(() => wrong.fetchFrom(new S3Target({ endpoint, bucket: 'bkt', accessKeyId: 'AK', secretAccessKey: 'SECRET' }), 'net', r1.snapshot), /integrity|wrong recovery key|not a SmartSave/);
    srv.close();
    ok('network drops and server errors: shown as failing (not protected), retried with backoff, uploads resume without duplicates, verified');
    ok('restore on a new computer from cloud storage with the recovery key (original computer not needed); a wrong key is refused');
  }

  // ---------- folder target + retention ----------
  {
    const { proj, ss } = mk('ret', { targets: [{ id: 'usb', type: 'folder', name: 'USB', dir: path.join(T, 'usb') }] });
    w(proj, 'a.txt', 'x'); ss.checkpoint('ret'); await ss.uploadPending();
    const verified = ss.state().targets.usb.verified.ret.id;
    const now = Date.now(); const r = ss.repo;
    const oid = r.put(Buffer.from('old')).id;
    const times = [];
    for (let h = 1; h <= 24 * 60; h += 7) times.push(now - h * 3600e3); // a snapshot every 7 hours for 60 days
    for (const t of times) r.putSnapshot({ v: 1, id: Math.floor(t).toString(36).padStart(9, '0') + '-' + crypto.randomBytes(2).toString('hex'), workspace: 'ret', time: new Date(t).toISOString(), files: [{ path: 'a.txt', id: oid, size: 3 }], deleted: [] });
    const total = r.snapshotIds('ret').length;
    const dry = ss.prune({ dryRun: true });
    assert.equal(r.snapshotIds('ret').length, total, 'dry run deletes nothing');
    assert.ok(dry.ret.dropped.length > 0 && !dry.ret.dropped.includes(verified), 'never drops the verified copy');
    const real = ss.prune({ dryRun: false });
    assert.equal(r.snapshotIds('ret').length, total - real.ret.dropped.length);
    assert.ok(r.snapshotIds('ret').includes(verified));
    ok(`retention keeps recent + hourly/daily/weekly versions (kept ${real.ret.kept} of ${total}), dry run first, never the last verified copy`);
  }

  // ---------- quota signals ----------
  {
    const now = Date.now(); const L = (pct, ageMin = 1, extra = {}) => ({ checkedAt: new Date(now - ageMin * 60000).toISOString(), primary: { usedPercent: pct }, ...extra });
    assert.deepEqual(usageCrossing(0, null, now), { band: null, save: false, reason: 'unknown' });
    assert.equal(usageCrossing(0, L(95, 45), now).reason, 'stale');
    assert.equal(usageCrossing(0, L(50), now).save, false);
    assert.ok(usageCrossing(0, L(76), now).save);
    assert.equal(usageCrossing(75, L(80), now).save, false, 'once per band (cooldown)');
    assert.ok(usageCrossing(75, L(91), now).save);
    assert.equal(usageCrossing(90, L(20), now).band, 0, 're-armed after the limit window resets');
    assert.ok(usageCrossing(0, L(10, 1, { limitReached: true }), now).save, 'a reached limit saves');
    ok('usage limits: saves at 75% and 90% once each; unknown or stale numbers never trigger (timers keep saving)');
  }

  // ---------- agent hooks: out of tokens, compaction, session end (inside a real vault) ----------
  {
    const vault = path.join(T, 'vault-hooks'); const proj = path.join(T, 'hookproj');
    w(proj, 'main.py', 'print(1)');
    fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ smartsave: { enabled: true, projects: { hk: { enabled: true, root: proj } } } }));
    const { Store } = require('../src/store'); new Store(vault).create('project', { title: 'hk' });
    const hooks = require('../src/claude-hooks');
    const base = { session_id: 'abc', cwd: path.join(proj), transcript_path: '' };
    await hooks.runHook({ ...base, hook_event_name: 'StopFailure', error: 'rate_limit' }, vault);
    w(proj, 'main.py', 'print(2)');
    await hooks.runHook({ ...base, hook_event_name: 'PreCompact', trigger: 'auto' }, vault);
    w(proj, 'main.py', 'print(3)');
    await hooks.runHook({ ...base, hook_event_name: 'SessionEnd', reason: 'logout' }, vault);
    const ss = new SmartSave({ home: path.join(vault, '.cortex', 'smartsave'), config: () => ({ enabled: true, projects: { hk: { enabled: true, root: proj } } }) });
    const reasons = ss.snapshots('hk').map((x) => x.reason);
    assert.ok(reasons.some((r) => /rate_limit/.test(r)) && reasons.some((r) => /compaction/.test(r)) && reasons.some((r) => /session ended/.test(r)), reasons.join(' | '));
    await hooks.runHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'main.py') } }, vault);
    assert.ok(fs.readdirSync(path.join(vault, '.cortex', 'smartsave', 'triggers')).length >= 1, 'edits only leave a cheap "changed" marker');
    assert.ok(hooks.EVENTS.PreCompact && hooks.EVENTS.StopFailure);
    ok('agent running out of tokens, context compaction and session end each save a checkpoint first (no AI used)');
  }

  // ---------- git is never touched ----------
  {
    const { proj, ss } = mk('git');
    w(proj, 'a.txt', 'a');
    if (spawnSync('git', ['--version']).status === 0) {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: proj }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'add', '.'], { cwd: proj }); spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: proj });
      w(proj, 'a.txt', 'uncommitted edit'); w(proj, 'new.txt', 'untracked');
      const idx = fs.readFileSync(path.join(proj, '.git', 'index')); const st0 = spawnSync('git', ['status', '--porcelain'], { cwd: proj }).stdout.toString();
      const r = ss.checkpoint('git');
      assert.ok(fs.readFileSync(path.join(proj, '.git', 'index')).equals(idx), 'git index unchanged');
      assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: proj }).stdout.toString(), st0);
      const m = ss.repo.getSnapshot('git', r.snapshot);
      assert.equal(m.git.branch, 'main'); assert.ok(m.files.some((f) => f.path === 'new.txt'), 'untracked files are saved');
      assert.ok(!m.files.some((f) => f.path.startsWith('.git/')));
      ok('uncommitted and untracked work is saved with the branch; git index, commits and working tree are never touched');
    } else { console.log('  (git not installed: skipped git check)'); }
  }

  // ---------- before a Cortex update ----------
  {
    const vault = path.join(T, 'vault-upd'); const proj = path.join(T, 'updproj'); w(proj, 'a.txt', 'work in progress');
    const { Store } = require('../src/store'); const st = new Store(vault); st.create('project', { title: 'Upd', folder: proj });
    const cfg = { smartsave: { enabled: true, debounceSec: 15, intervalSec: 120, projects: { upd: { enabled: true } }, targets: [{ id: 'usb', type: 'folder', name: 'USB', dir: path.join(T, 'upd-usb') }] } };
    const svc = require('../src/smartsave/service').startService({ vault, store: st, conf: () => cfg });
    await svc.beforeUpdate();
    const reasons = svc.ss.snapshots('upd').map((x) => x.reason);
    svc.stop();
    assert.ok(reasons.includes('before update'), reasons.join(','));
    assert.equal(svc.ss.status().projects.upd.targets[0].state, 'verified', 'and uploaded before the update starts');
    ok('before Cortex installs an update, every protected project is saved and uploaded');
  }

  // ---------- real server: dashboard API, update checkpoint, a paired computer keeps a copy and restores with the main PC OFF ----------
  {
    const vault = path.join(T, 'vault-srv'); const proj = path.join(T, 'srvproj'); const work = path.join(T, 'runner-work');
    fs.mkdirSync(work, { recursive: true });
    for (let i = 0; i < 25; i++) w(proj, `src/m${i}.js`, `export const v${i} = ${i};\n`);
    w(proj, '.env', 'STRIPE=sk_live_' + 'x'.repeat(24));
    fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ remote: { enabled: true }, agents: { enabled: true, folders: [work] } }));
    const { Store } = require('../src/store'); const st = new Store(vault); st.create('project', { title: 'Shop', folder: proj });
    const port = 44000 + Math.floor(Math.random() * 1000);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'cortex.js'), 'serve', '--vault', vault, '--port', String(port)], { stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    const J = async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
    try {
      const pv = await J(await fetch(base + '/api/smartsave/preview?project=shop'));
      assert.equal(pv.included, 25); assert.ok(pv.skipped.some((x) => x.path === '.env'));
      await J(await post('/api/smartsave/settings', { enabled: true, project: { id: 'shop', enabled: true } }));
      let s;
      for (let i = 0; i < 20; i++) { await sleep(500); s = await J(await fetch(base + '/api/smartsave/status')); if (s.projects.shop.snapshots >= 1) break; }
      assert.equal(s.projects.shop.protection, 'local-only', 'clearly local-only until a backup destination exists');
      w(proj, 'src/m1.js', 'export const v1 = "edited";\n');
      for (let i = 0; i < 50; i++) { await sleep(500); s = await J(await fetch(base + '/api/smartsave/status')); if (s.projects.shop.snapshots >= 2) break; }
      assert.ok(s.projects.shop.snapshots >= 2, 'a file change is saved automatically after it settles');
      const now = await J(await post('/api/smartsave/save', { project: 'shop' }));
      assert.ok(now.snapshot);
      assert.equal((await fetch(base + '/api/runner/smartsave/objects/aa/' + 'a'.repeat(64), { method: 'PUT', body: 'junk' })).status, 401, 'uploads need a paired computer');
      // pair a second computer; it keeps a copy of the main PC's saves
      const cc = await J(await post('/api/devices/code', { kind: 'computer' }));
      process.env.CORTEX_RUNNER_HOME = path.join(T, 'runner-home');
      delete require.cache[require.resolve('../src/runner-client')];
      const rc = require('../src/runner-client');
      const conf = await rc.pair({ hub: base, code: cc.code, name: 'Laptop', folders: [work] });
      const n = await rc.replicate(conf, () => {});
      assert.ok(n >= 3, 'paired computer copied the checkpoints');
      s = await J(await fetch(base + '/api/smartsave/status'));
      assert.ok(s.projects.shop.targets.some((t) => t.type === 'paired' && t.state === 'verified'), 'main PC shows the paired copy as verified');
      assert.equal(s.projects.shop.protection, 'protected');
      const bad = await fetch(base + '/api/runner/smartsave/objects/aa/' + 'a'.repeat(64), { method: 'PUT', headers: { Authorization: 'Bearer ' + conf.token }, body: 'junk' });
      assert.equal(bad.status, 400, 'the main Cortex only accepts intact, correctly encrypted objects');
      const latest = (await J(await fetch(base + '/api/smartsave/snapshots?project=shop'))).snapshots[0];
      // the main PC turns off
      srv.kill('SIGKILL'); await sleep(300);
      const laptop = new SmartSave({ home: path.join(T, 'runner-home', 'smartsave'), key: SmartSave.parseRecoveryKey(require('../src/smartsave').SmartSave.prototype.recoveryKey.call({ key: Buffer.from(fs.readFileSync(path.join(vault, '.cortex', 'smartsave', 'key'), 'utf8').trim(), 'base64url') })), config: () => ({}) });
      const out = path.join(work, 'shop-restored');
      const r = laptop.restore('shop', latest.id, { dest: out });
      assert.equal(r.failed.length, 0); assert.equal(r.verified, 25);
      const rels = laptop.repo.getSnapshot('shop', latest.id).files.map((f) => f.path);
      assert.deepEqual(treeHash(out, rels), treeHash(proj, rels), 'exact byte match');
      assert.ok(!fs.existsSync(path.join(out, '.env')), 'the secret never left the main PC');
      assert.ok(fs.readFileSync(path.join(out, 'CORTEX-RESTORE.md'), 'utf8').includes('Project: shop'));
      ok('dashboard API: preview, auto-save after a change, Save now; "local only" until protected');
      ok('a paired computer keeps verified copies; with the main PC switched off it restores the latest work byte-for-byte');
    } finally { try { srv.kill('SIGKILL'); } catch { /* gone */ } }
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`All ${passed} SmartSave checks passed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
