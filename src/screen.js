'use strict';
// Capture the computer's screen using built-in OS tools (no dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(stdout)));
  });
}

function which(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

function linuxCommands(out) {
  const wayland = !!process.env.WAYLAND_DISPLAY;
  const list = [
    wayland && ['grim', [out]],
    ['gnome-screenshot', ['-f', out]],
    ['spectacle', ['-b', '-n', '-f', '-o', out]],
    !wayland && ['scrot', ['-o', out]],
    !wayland && ['import', ['-silent', '-window', 'root', out]],
    !wayland && ['maim', [out]],
  ];
  return list.filter(Boolean).filter(([b]) => which(b));
}

async function capture() {
  const out = path.join(os.tmpdir(), `cortex-screen-${process.pid}-${Date.now()}.${process.platform === 'linux' ? 'png' : 'jpg'}`);
  try {
    if (process.platform === 'darwin') {
      await run('screencapture', ['-x', '-t', 'jpg', out]);
    } else if (process.platform === 'win32') {
      // Fast path: the long-running capture helper (no new PowerShell per frame). Falls back below.
      try { return await require('./windows').captureScreen(1920); } catch { /* fall back to a one-off capture */ }
      const ps =`Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;
$g=[System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);
$bmp.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Jpeg);
$g.Dispose();$bmp.Dispose()`;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    } else {
      const cmds = linuxCommands(out);
      if (!cmds.length) throw new Error('No screenshot tool found. Install one of: grim (Wayland), gnome-screenshot, scrot, or ImageMagick.');
      let last;
      for (const [bin, args] of cmds) {
        try { await run(bin, args); if (fs.existsSync(out) && fs.statSync(out).size > 0) break; } catch (e) { last = e; }
      }
      if (!fs.existsSync(out)) throw last || new Error('Screenshot failed');
    }
    const buf = fs.readFileSync(out);
    if (buf.length < 100) throw new Error('Empty screenshot. On macOS, allow Screen Recording for your terminal/Node in System Settings → Privacy & Security.');
    return buf;
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

// Shared, throttled capture so several viewers don't spawn several screenshot processes.
let cache = null;
let pending = null;
async function captureCached(maxAgeMs = 900) {
  if (cache && Date.now() - cache.ts < maxAgeMs) return cache.buf;
  if (!pending) pending = capture().then((buf) => { cache = { buf, ts: Date.now() }; return buf; }).finally(() => { pending = null; });
  return pending;
}

module.exports = { capture, captureCached };
