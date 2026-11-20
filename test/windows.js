'use strict';
// Live view of AI windows. Rules everywhere; on Windows, real windows: covered, on top, minimized, closed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const win = require(path.join(ROOT, 'src', 'windows.js'));
const ok = (m) => console.log('  ✓ ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Three real windows: A ("claude…", magenta) fully covered by B (plain, lime, always on top); C ("claude…") minimized.
const TEST_WINDOWS = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function F($t, $c, $x, $top, $min) { $f = New-Object Windows.Forms.Form; $f.Text = $t; $f.BackColor = $c; $f.StartPosition = 'Manual'; $f.Location = New-Object Drawing.Point($x, 120); $f.Size = New-Object Drawing.Size(420, 320); $f.TopMost = $top; if ($min) { $f.WindowState = 'Minimized' }; $f.Show(); $f }
$a = F 'claude cortex-test-A' ([Drawing.Color]::Magenta) 60 $false $false
$b = F 'plain cortex-test-B' ([Drawing.Color]::Lime) 60 $true $false
$c = F 'claude cortex-test-C' ([Drawing.Color]::Cyan) 600 $false $true
[Windows.Forms.Application]::DoEvents()
[Console]::Out.WriteLine('UP'); [Console]::Out.Flush()
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 120) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }`;

function openTestWindows() {
  const enc = Buffer.from(TEST_WINDOWS, 'utf16le').toString('base64');
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('test windows did not open')), 30000);
    p.stdout.on('data', (d) => { out += d; if (out.includes('UP')) { clearTimeout(t); resolve(p); } });
    p.on('exit', () => reject(new Error('test window process exited')));
  });
}

(async () => {
  console.log('AI windows');
  // ---- rules (every platform) ----
  const c = (process, title, watch) => win.classify({ process, title }, watch);
  assert.equal(c('claude', 'Claude').app, 'Claude');
  assert.equal(c('ChatGPT', 'ChatGPT').family, 'openai');
  assert.equal(c('Codex', 'Codex').app, 'Codex');
  assert.equal(c('WindowsTerminal', '✳ Fix the login bug').app, 'Claude Code');
  assert.equal(c('pwsh', 'codex - my-app').app, 'Codex CLI');
  assert.equal(c('WindowsTerminal', 'Windows PowerShell'), null, 'a plain terminal is not an AI');
  assert.equal(c('msedge', 'Claude - Microsoft Edge').app, 'Claude (browser)');
  assert.equal(c('chrome', 'ChatGPT - Google Chrome').family, 'openai');
  assert.equal(c('msedge', 'New tab and 43 more pages - Microsoft Edge'), null, 'a browser on another page is not an AI');
  assert.equal(c('notepad', 'notes.txt'), null);
  assert.equal(c('notepad', 'notes.txt', [{ process: 'notepad', title: 'notes' }]).kind, 'watched');
  assert.equal(c('notepad', 'other.txt', [{ process: 'notepad', title: 'notes' }]), null, 'watch matches the chosen title only');
  ok('AI apps, AI terminals and AI browser tabs are recognised; other windows are not (unless chosen)');

  if (!win.supported) { console.log('  - real window checks skipped (Windows only)\n\nAll AI window checks passed.'); return; }

  // ---- real windows ----
  const tw = await openTestWindows();
  try {
    await sleep(600);
    const all = await win.listAll();
    const find = (t) => all.find((w) => w.title === t);
    const A = find('claude cortex-test-A'); const B = find('plain cortex-test-B'); const C = find('claude cortex-test-C');
    assert.ok(A && B && C, 'test windows listed');
    assert.equal(win.classify(A).app, 'Claude Code');
    assert.equal(win.classify(B), null);
    assert.equal(C.minimized, true);
    ok('lists real windows with their app, title and minimized state');

    const [r, g, b] = await win.averageColor(A.id);
    assert.ok(r > 200 && g < 70 && b > 200, `covered window captured as itself (magenta), got ${r},${g},${b}`);
    const [r2, g2, b2] = await win.averageColor(B.id);
    assert.ok(g2 > 200 && r2 < 70 && b2 < 70, `top window is lime, got ${r2},${g2},${b2}`);
    ok('a window covered by another window is captured as itself, not what covers it');

    const shot = await win.captureWindow(A.id, 400);
    assert.ok(shot.buf && shot.buf[0] === 0xff && shot.buf[1] === 0xd8, 'JPEG');
    assert.equal((await win.captureWindow(C.id)).state, 'minimized');
    ok('captures a JPEG; a minimized window is reported as minimized');

    const pid = win.helperPid();
    const times = [];
    for (let i = 0; i < 30; i++) { const t0 = Date.now(); const s = await win.captureWindow(A.id, 720); assert.ok(s.buf); times.push(Date.now() - t0); }
    assert.equal(win.helperPid(), pid, 'one helper process reused');
    const avg = Math.round(times.reduce((x, y) => x + y, 0) / times.length);
    assert.ok(Math.max(...times) < 3000, 'no capture took over 3 s');
    ok(`30 captures in a row, all good, ${avg} ms on average (max ${Math.max(...times)} ms), one helper process`);

    process.kill(pid);
    await sleep(500);
    assert.ok((await win.captureWindow(A.id, 400)).buf, 'works again after the helper was killed');
    assert.notEqual(win.helperPid(), pid);
    ok('the helper restarts by itself after it was killed');

    // ---- through the server: only AI windows where an agent is working ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-win-'));
    const vault = path.join(tmp, 'vault');
    fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ screen: { enabled: true } }));
    const port = 19000 + Math.floor(Math.random() * 900);
    const base = `http://127.0.0.1:${port}`;
    const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'cortex.js'), 'serve', '--vault', vault, '--port', String(port)], { env: { ...process.env, USERPROFILE: path.join(tmp, 'home'), HOME: path.join(tmp, 'home') }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(250); } }
      const list = async () => (await (await fetch(base + '/api/windows')).json()).windows;
      let wl = await list();
      const a1 = wl.find((w) => w.id === A.id);
      assert.ok(a1 && a1.active === false, 'AI window listed but not active while no agent works');
      assert.ok(!wl.some((w) => w.id === B.id), 'non-AI window never listed');
      require(path.join(ROOT, 'src', 'sessions.js')).upsert(vault, 'cc-wintest', { agent: 'claude-code', status: 'working', step: 'Testing', title: 'test', cwd: tmp });
      await sleep(2100); // window list is cached for 2 s
      wl = await list();
      const a2 = wl.find((w) => w.id === A.id);
      assert.ok(a2.active === true && a2.session === 'cc-wintest', 'active while a Claude agent is working');
      const sh = await fetch(`${base}/api/windows/shot?id=${A.id}&w=400`);
      assert.equal(sh.status, 200); assert.equal(sh.headers.get('content-type'), 'image/jpeg');
      assert.equal((await fetch(`${base}/api/windows/shot?id=${B.id}`)).status, 404, 'a non-AI window can never be captured');
      assert.equal((await fetch(`${base}/api/windows/shot?id=${C.id}`)).status, 409, 'minimized');
      ok('server: AI windows only, "active" only while that AI\'s agent works, other windows refused');

      fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ screen: { enabled: false } }));
      assert.equal((await fetch(`${base}/api/windows/shot?id=${A.id}`)).status, 403);
      assert.equal((await (await fetch(base + '/api/windows')).json()).enabled, false);
      ok('nothing is captured while screen sharing is off');
    } finally { srv.kill(); }

    tw.kill();
    await sleep(800);
    assert.equal((await win.captureWindow(A.id)).state, 'gone');
    ok('a closed window is reported as gone');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
  } finally {
    try { tw.kill(); } catch { /* closed */ }
    win.stop();
  }
  console.log('\nAll AI window checks passed.');
})().catch((e) => { console.error('FAILED:', e); win.stop(); process.exit(1); });
