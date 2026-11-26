'use strict';
// One-file installers (2.3, checklist #20): double-click, no terminal. Each installer
//   1. (second computers) pairs with your main Cortex FIRST, because pairing codes expire after 10 minutes,
//   2. installs Node.js if it's missing (Windows: winget; Mac: the official installer from nodejs.org),
//   3. downloads Cortex from its release source (no git needed) into ~/Cortex-app,
//   4. main computer: runs the normal setup (connects your AI apps, start at login) and opens the dashboard;
//      second computer: starts the runner (optionally as a standby host) and makes it start at login.
// The installer holds only a one-time pairing code (never a device key). Mac installers come inside a .zip so the
// file stays double-clickable (browsers drop the "executable" flag on plain downloads).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function source() {
  let url = 'https://codeload.github.com/w6d8g5tgvy-star/cortex/tar.gz/refs/heads/main';
  try { url = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release.json'), 'utf8')).url || url; } catch { /* default */ }
  const m = url.match(/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/refs\/heads\/([\w.-]+)/);
  const [owner, repo, branch] = m ? [m[1], m[2], m[3]] : ['w6d8g5tgvy-star', 'cortex', 'main'];
  return { tar: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`, zip: `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`, folder: `${repo}-${branch}` };
}
const clean = (s, re) => String(s || '').replace(re, '');
function opts({ hub = '', code = '', standby = false } = {}) {
  const h = clean(hub, /[^A-Za-z0-9:/._-]/g).replace(/\/+$/, '');
  const c = clean(code, /[^A-Za-z0-9-]/g).toUpperCase().slice(0, 12);
  if (c && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(h)) throw new Error('The main Cortex address is missing or invalid');
  return { hub: h, code: c, mode: c ? 'computer' : 'main', standby: !!standby && !!c };
}

function windows(o) {
  const { hub, code, mode, standby } = opts(o); const src = source();
  return [
    '@echo off',
    'setlocal',
    'title Install Cortex',
    'REM Cortex installer for Windows. Double-click to run. Safe to run again (it updates Cortex).',
    `set "HUB=${hub}"`, `set "CODE=${code}"`, `set "MODE=${mode}"`, `set "STANDBY=${standby ? '1' : '0'}"`,
    'set "APP=%USERPROFILE%\\Cortex-app"',
    'set "RUNNER=%USERPROFILE%\\.cortex-runner"',
    'echo.', 'echo  Installing Cortex. This takes a few minutes; keep this window open.', 'echo.',
    'if not "%MODE%"=="computer" goto node',
    'echo [1/4] Pairing this computer with your main Cortex...',
    'if not exist "%RUNNER%" mkdir "%RUNNER%"',
    'curl.exe -s -f -X POST "%HUB%/api/pair" -H "Content-Type: application/json" -d "{\\"code\\":\\"%CODE%\\",\\"name\\":\\"%COMPUTERNAME%\\",\\"platform\\":\\"windows %COMPUTERNAME%\\",\\"format\\":\\"runner-config\\",\\"hub\\":\\"%HUB%\\"}" -o "%RUNNER%\\config.json"',
    'if errorlevel 1 (echo. & echo  Pairing failed: the code may have expired or your main computer is off. Make a new code in Cortex: Settings, Devices, Add a computer. & pause & exit /b 1)',
    ':node',
    'echo [2/4] Checking Node.js...',
    'where node >nul 2>nul && goto havenode',
    'if exist "%ProgramFiles%\\nodejs\\node.exe" goto addnode',
    'echo  Installing Node.js (you may be asked to allow it)...',
    'winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements',
    ':addnode',
    'set "PATH=%ProgramFiles%\\nodejs;%PATH%"',
    'where node >nul 2>nul || (echo. & echo  Node.js could not be installed automatically. Install the LTS version from nodejs.org, then run this installer again. & start https://nodejs.org & pause & exit /b 1)',
    ':havenode',
    'for /f "delims=" %%i in (\'where node\') do (set "NODE=%%i" & goto gotnode)',
    ':gotnode',
    'echo [3/4] Downloading Cortex...',
    'set "TMPD=%TEMP%\\cortex-install-%RANDOM%"',
    'mkdir "%TMPD%"',
    `curl.exe -L -f -s -o "%TMPD%\\cortex.zip" "${src.zip}"`,
    'if errorlevel 1 (echo  Download failed. Check your internet connection and run this again. & pause & exit /b 1)',
    'tar -xf "%TMPD%\\cortex.zip" -C "%TMPD%"',
    'if errorlevel 1 (echo  Could not unpack Cortex. & pause & exit /b 1)',
    `if exist "%APP%\\bin\\cortex.js" (robocopy "%TMPD%\\${src.folder}" "%APP%" /E /NFL /NDL /NJH /NJS /NP >nul) else (move "%TMPD%\\${src.folder}" "%APP%" >nul)`,
    'rmdir /s /q "%TMPD%" 2>nul',
    'if not exist "%APP%\\bin\\cortex.js" (echo  Cortex could not be put in place at %APP%. & pause & exit /b 1)',
    'echo [4/4] Setting up...',
    'if "%MODE%"=="computer" goto computer',
    '"%NODE%" "%APP%\\bin\\cortex.js" setup',
    'start "Cortex" /min "%NODE%" "%APP%\\bin\\cortex.js" start --open-settings',
    'echo.', 'echo  Done. Cortex is open in your browser and starts by itself when you sign in.', 'timeout /t 8 >nul', 'exit /b 0',
    ':computer',
    'set "ARGS=runner"',
    'if "%STANDBY%"=="1" set "ARGS=runner --standby"',
    '> "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Cortex runner.cmd" echo @start "Cortex runner" /min "%NODE%" "%APP%\\bin\\cortex.js" %ARGS%',
    'start "Cortex runner" /min "%NODE%" "%APP%\\bin\\cortex.js" %ARGS%',
    'echo.',
    'if "%STANDBY%"=="1" (echo  Done. This computer is connected to your main Cortex and keeps a standby copy: if the main computer is off, Cortex opens here at http://localhost:7777) else (echo  Done. This computer is connected to your main Cortex and can run agent jobs.)',
    'echo  It starts by itself when you sign in. To remove it: delete "Cortex runner" from your Startup folder and remove the computer in Cortex, Settings, Devices.',
    'pause',
    '',
  ].join('\r\n');
}

function unix(o, platform) {
  const { hub, code, mode, standby } = opts(o); const src = source(); const mac = platform === 'mac';
  const say = mac ? 'osascript -e "display alert \\"Cortex\\" message \\"$1\\"" >/dev/null 2>&1 || true' : 'true';
  return `#!/bin/bash
# Cortex installer for ${mac ? 'macOS' : 'Linux'}. ${mac ? 'Double-click to run (the first time: right-click, then Open).' : 'Run: bash install-cortex.sh'} Safe to run again (it updates Cortex).
HUB="${hub}"; CODE="${code}"; MODE="${mode}"; STANDBY="${standby ? '1' : '0'}"
APP="$HOME/Cortex-app"; RUNNER="$HOME/.cortex-runner"
fail() { echo; echo "  $1"; ${say}; read -r -p "Press Enter to close" _; exit 1; }
echo; echo "  Installing Cortex. This takes a few minutes; keep this window open."; echo
if [ "$MODE" = "computer" ]; then
  echo "[1/4] Pairing this computer with your main Cortex..."
  mkdir -p "$RUNNER"
  NAME="$(${mac ? 'scutil --get ComputerName 2>/dev/null || ' : ''}hostname)"
  curl -s -f -X POST "$HUB/api/pair" -H "Content-Type: application/json" -d "{\\"code\\":\\"$CODE\\",\\"name\\":\\"$NAME\\",\\"platform\\":\\"${mac ? 'darwin' : 'linux'} $NAME\\",\\"format\\":\\"runner-config\\",\\"hub\\":\\"$HUB\\"}" -o "$RUNNER/config.json" || fail "Pairing failed: the code may have expired or your main computer is off. Make a new code in Cortex: Settings, Devices, Add a computer."
  chmod 600 "$RUNNER/config.json"
fi
echo "[2/4] Checking Node.js..."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
${mac ? `  echo "  Installing Node.js (the installer window will open; follow it, then come back here)..."
  PKG="$(curl -s https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v[0-9.]*\\.pkg' | head -1)"
  [ -n "$PKG" ] || fail "Couldn't find the Node.js installer. Install the LTS version from nodejs.org, then run this again."
  curl -L -s -o "/tmp/$PKG" "https://nodejs.org/dist/latest-v22.x/$PKG" && open -W "/tmp/$PKG"
  export PATH="/usr/local/bin:$PATH"` : `  if command -v apt-get >/dev/null 2>&1; then echo "  Installing Node.js (asks for your password)..."; sudo apt-get update -qq && sudo apt-get install -y -qq nodejs; fi`}
fi
command -v node >/dev/null 2>&1 || fail "Node.js could not be installed automatically. Install the LTS version from https://nodejs.org, then run this again."
NODE="$(command -v node)"
echo "[3/4] Downloading Cortex..."
TMPD="$(mktemp -d)"
curl -L -f -s "${src.tar}" | tar -xz -C "$TMPD" || fail "Download failed. Check your internet connection and run this again."
mkdir -p "$APP" && cp -R "$TMPD/${src.folder}/." "$APP/" && rm -rf "$TMPD"
[ -f "$APP/bin/cortex.js" ] || fail "Cortex could not be put in place at $APP."
echo "[4/4] Setting up..."
if [ "$MODE" != "computer" ]; then
  "$NODE" "$APP/bin/cortex.js" setup
  nohup "$NODE" "$APP/bin/cortex.js" start --open-settings >/dev/null 2>&1 &
  echo; echo "  Done. Cortex is open in your browser and starts by itself when you sign in."; sleep 5; exit 0
fi
ARGS="runner"; [ "$STANDBY" = "1" ] && ARGS="runner --standby"
${mac ? `PL="$HOME/Library/LaunchAgents/com.cortex.runner.plist"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.cortex.runner</string><key>ProgramArguments</key><array><string>$NODE</string><string>$APP/bin/cortex.js</string>$(for a in $ARGS; do printf '<string>%s</string>' "$a"; done)</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$RUNNER/runner.log</string><key>StandardErrorPath</key><string>$RUNNER/runner.log</string></dict></plist>
PLIST
launchctl unload "$PL" 2>/dev/null; launchctl load "$PL"
REMOVE="run: launchctl unload ~/Library/LaunchAgents/com.cortex.runner.plist, delete that file, and remove the computer in Cortex (Settings, Devices)"` : `mkdir -p "$HOME/.config/autostart"
printf '[Desktop Entry]\\nType=Application\\nName=Cortex runner\\nExec=%s %s %s\\nX-GNOME-Autostart-enabled=true\\n' "$NODE" "$APP/bin/cortex.js" "$ARGS" > "$HOME/.config/autostart/cortex-runner.desktop"
nohup "$NODE" "$APP/bin/cortex.js" $ARGS >"$RUNNER/runner.log" 2>&1 &
REMOVE="delete ~/.config/autostart/cortex-runner.desktop and remove the computer in Cortex (Settings, Devices)"`}
echo
if [ "$STANDBY" = "1" ]; then echo "  Done. This computer is connected to your main Cortex and keeps a standby copy: if the main computer is off, Cortex opens here at http://localhost:7777"; else echo "  Done. This computer is connected to your main Cortex and can run agent jobs."; fi
echo "  It starts by itself when you sign in. To remove it: $REMOVE."
read -r -p "Press Enter to close" _
`;
}

// ---- minimal zip writer (one file, deflate, unix permissions) so the Mac .command stays executable ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipOne(name, data, mode = 0o100755) {
  const nameB = Buffer.from(name, 'utf8'); const comp = zlib.deflateRawSync(data); const crc = crc32(data);
  const d = new Date(); const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameB.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(0, 42);
  const off = local.length + nameB.length + comp.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nameB.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([local, nameB, comp, central, nameB, end]);
}

/** The installer file for an OS: { name, type, body }. */
function build(os_, o = {}) {
  const suffix = o.code ? ' (connect to main Cortex)' : '';
  if (os_ === 'windows') return { name: `Install Cortex${suffix}.cmd`, type: 'application/octet-stream', body: Buffer.from(windows(o)) };
  if (os_ === 'mac') return { name: `Install Cortex${suffix}.zip`, type: 'application/zip', body: zipOne(`Install Cortex${suffix}.command`, Buffer.from(unix(o, 'mac'))) };
  if (os_ === 'linux') return { name: 'install-cortex.sh', type: 'text/x-shellscript', body: Buffer.from(unix(o, 'linux')) };
  throw new Error('Choose windows, mac or linux');
}

module.exports = { build, windows, unix, zipOne, crc32, source, opts };
