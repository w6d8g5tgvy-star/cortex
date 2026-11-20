'use strict';
// Fetcher readiness: is everything Fetcher needs installed and signed in, and a one-click installer for what isn't.
// Installs only run for requests from this computer (the server checks), and only fixed package ids are used.
const { execFile, spawn } = require('child_process');
const media = require('./media');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

// What Fetcher uses, why, and how to install it on each system.
const ITEMS = {
  ytdlp: { label: 'yt-dlp', bin: 'yt-dlp', versionArgs: ['--version'], required: true,
    why: 'Downloads captions, comments and screen clips. Without it Fetcher only sees titles and descriptions.',
    winget: 'yt-dlp.yt-dlp', brew: 'yt-dlp', linux: 'python3 -m pip install -U "yt-dlp[default]"' },
  deno: { label: 'Deno', bin: 'deno', versionArgs: ['--version'], required: true,
    why: 'yt-dlp needs a JavaScript runtime to unlock YouTube downloads.',
    winget: 'DenoLand.Deno', brew: 'deno', linux: 'curl -fsSL https://deno.land/install.sh | sh' },
  ffmpeg: { label: 'FFmpeg', bin: 'ffmpeg', versionArgs: ['-version'], required: false,
    why: 'Grabs still frames so the checker can see code and settings on screen. Optional: without it frames are skipped.',
    winget: 'yt-dlp.FFmpeg', brew: 'ffmpeg', linux: 'sudo apt install ffmpeg' },
  claude: { label: 'Claude Code (signed in)', required: true,
    why: 'Plans the searches and checks each video. Uses your Claude plan.',
    help: WIN ? 'In PowerShell: irm https://claude.ai/install.ps1 | iex   then run  claude  once to sign in.' : 'curl -fsSL https://claude.ai/install.sh | bash   then run  claude  once to sign in.' },
  codex: { label: 'Codex (signed in)', required: false,
    why: 'Optional: lets Codex be the usefulness checker instead of Claude.',
    help: 'Install the Codex app or  npm install -g @openai/codex , then run  codex login .' },
};

function run(bin, args, timeout = 20000) {
  return new Promise((res) => {
    const shell = WIN && /\.(cmd|bat)$/i.test(bin);
    execFile(shell ? `"${bin}"` : bin, args, { env: media.toolEnv(), windowsHide: true, timeout, shell }, (e, out, err) =>
      res({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(out || ''), err: String(err || '') }));
  });
}
const firstLine = (s) => String(s).split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';

function installCommand(key) {
  const it = ITEMS[key];
  if (!it) return null;
  if (it.help) return it.help;
  if (WIN) return `winget install --id ${it.winget} -e --silent --accept-package-agreements --accept-source-agreements`;
  if (MAC) return `brew install ${it.brew}`;
  return it.linux;
}

/** Can this computer install with one click? (winget on Windows, Homebrew on Mac; Linux shows the command.) */
async function installer() {
  if (WIN) return (await media.which('winget')) ? 'winget' : null;
  if (MAC) return (await media.which('brew')) ? 'brew' : null;
  return null;
}

/** Status of every item. `runner` is an AgentRunner (to find claude/codex where Cortex already looks). */
async function check(runner) {
  const out = {};
  const bins = ['ytdlp', 'deno', 'ffmpeg'];
  await Promise.all(bins.map(async (k) => {
    const it = ITEMS[k];
    const p = k === 'ytdlp' && process.env.CORTEX_YTDLP ? process.env.CORTEX_YTDLP : await media.which(it.bin);
    let version = '';
    if (p && !/\.js$/i.test(p)) { const r = await run(p, it.versionArgs); version = firstLine(r.out).replace(/^(ffmpeg version|deno)\s+/i, '').split(/\s+/)[0].slice(0, 24); }
    out[k] = { ok: !!p, path: p || null, version };
  }));
  const found = runner ? await runner.available() : {};
  const claudeBin = found.claude && found.claude.path;
  if (claudeBin) {
    const r = await run(claudeBin, ['auth', 'status']);
    let signedIn = null;
    try { signedIn = !!JSON.parse(r.out).loggedIn; } catch { signedIn = r.code === 0 ? null : false; }
    out.claude = { ok: signedIn !== false, installed: true, signedIn, path: claudeBin };
  } else out.claude = { ok: false, installed: false, signedIn: false };
  const codexBin = found.codex && found.codex.path;
  if (codexBin) {
    const r = await run(codexBin, ['login', 'status']);
    const signedIn = r.code === 0 && /logged in/i.test(r.out + r.err);
    out.codex = { ok: signedIn, installed: true, signedIn, path: codexBin };
  } else out.codex = { ok: false, installed: false, signedIn: false };
  const how = await installer();
  const items = Object.entries(ITEMS).map(([k, it]) => ({
    key: k, label: it.label, why: it.why, required: it.required, ...out[k],
    command: installCommand(k), canInstall: !!how && !it.help && !out[k].ok,
  }));
  return { ready: items.every((i) => !i.required || i.ok), installer: how, platform: process.platform, items };
}

// One install at a time; the dashboard polls `status()` for progress.
let job = null;
function status() { return job ? { key: job.key, running: job.running, ok: job.ok, log: job.log.slice(-2000) } : null; }

function install(key) {
  const it = ITEMS[key];
  if (!it || it.help) throw new Error('This one needs to be installed by hand: ' + (it ? it.help : 'unknown item'));
  if (job && job.running) throw new Error(`Still installing ${ITEMS[job.key].label}`);
  let bin; let args;
  if (WIN) { bin = 'winget'; args = ['install', '--id', it.winget, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']; }
  else if (MAC) { bin = 'brew'; args = ['install', it.brew]; }
  else throw new Error('Run this in a terminal: ' + it.linux);
  job = { key, running: true, ok: null, log: `> ${bin} ${args.join(' ')}\n` };
  const cur = job;
  const child = spawn(bin, args, { env: media.toolEnv(), windowsHide: true });
  const add = (d) => { cur.log = (cur.log + String(d).replace(/[\r\b]+/g, '\n').replace(/\n\s*[-\\|/]\s*\n/g, '\n')).slice(-8000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('error', (e) => { cur.running = false; cur.ok = false; add('\n' + e.message); });
  child.on('close', (code) => {
    cur.running = false;
    // winget 0x8A15002B = already installed and no newer version (Node may report it signed or unsigned).
    cur.ok = code === 0 || (WIN && code !== null && (code >>> 0) === 0x8A15002B);
    cur.log = cur.log.replace(/\n{3,}/g, '\n\n');
    add(`\n(finished, code ${code})`);
  });
  return status();
}

module.exports = { ITEMS, check, install, status, installCommand };
