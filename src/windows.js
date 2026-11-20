'use strict';
// Live view of the AI apps on this computer: find their windows and capture each one on its own
// (even when covered by other windows). Windows only for now; other systems report "not supported".
//
// Privacy: only windows recognised as AI apps, or windows the user explicitly chose to watch, can ever be
// captured (the server checks every capture request against that list), and only while screen sharing is on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'win-capture.ps1');
const supported = process.platform === 'win32';

// ---------- which windows are AI apps (pure, tested) ----------
const APPS = [
  [/^claude$/i, 'Claude', 'claude'],
  [/^chatgpt$/i, 'ChatGPT', 'openai'],
  [/^codex$/i, 'Codex', 'openai'],
  [/^cursor$/i, 'Cursor', 'cursor'],
  [/^windsurf$/i, 'Windsurf', 'windsurf'],
  [/^code( - insiders)?$/i, 'VS Code', 'vscode'],
];
const TERMINALS = /^(windowsterminal|openconsole|powershell|pwsh|cmd|conhost|wezterm-gui|alacritty|mintty|wt)$/i;
const BROWSERS = /^(msedge|chrome|firefox|brave|opera|vivaldi|arc|chromium|librewolf|zen)$/i;
const SITES = [
  [/\bclaude\b/i, 'Claude', 'claude'],
  [/chatgpt/i, 'ChatGPT', 'openai'],
  [/\bcodex\b/i, 'Codex', 'openai'],
  [/\bgemini\b/i, 'Gemini', 'google'],
  [/\bcopilot\b/i, 'Copilot', 'microsoft'],
  [/perplexity/i, 'Perplexity', 'perplexity'],
  [/\bgrok\b/i, 'Grok', 'xai'],
];

/** Is this window an AI app (or one the user chose to watch)? Returns { app, family, kind } or null. */
function classify(win, watch = []) {
  const proc = String(win.process || '');
  const title = String(win.title || '');
  for (const [re, app, family] of APPS) if (re.test(proc)) return { app, family, kind: 'app' };
  if (TERMINALS.test(proc)) {
    if (/\bcodex\b/i.test(title)) return { app: 'Codex CLI', family: 'openai', kind: 'terminal' };
    if (/\bclaude\b|✳/i.test(title)) return { app: 'Claude Code', family: 'claude', kind: 'terminal' };
  }
  if (BROWSERS.test(proc)) {
    for (const [re, app, family] of SITES) if (re.test(title)) return { app: `${app} (browser)`, family, kind: 'browser' };
  }
  for (const w of watch || []) {
    if (!w || !w.process || String(w.process).toLowerCase() !== proc.toLowerCase()) continue;
    if (w.title && !title.toLowerCase().includes(String(w.title).toLowerCase())) continue;
    return { app: w.label || proc, family: '', kind: 'watched' };
  }
  return null;
}

// ---------- the long-running capture helper ----------
let helper = null;

class Helper {
  constructor() {
    const enc = Buffer.from(fs.readFileSync(SCRIPT, 'utf8'), 'utf16le').toString('base64');
    this.p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.queue = [];
    this.buf = '';
    this.err = '';
    this.dead = false;
    this.started = false;
    this.ready = new Promise((res, rej) => { this.readyRes = res; this.readyRej = rej; });
    this.ready.catch(() => {});
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        this.onLine(line);
      }
    });
    this.p.stderr.on('data', (d) => { this.err = (this.err + d).slice(-4000); });
    this.p.stdin.on('error', () => {});
    this.p.on('exit', () => this.kill(new Error('The capture helper stopped' + (this.err.trim() ? ': ' + this.err.trim().split('\n').pop().slice(0, 200) : ''))));
    this.p.on('error', (e) => this.kill(e));
    this.touch();
  }

  onLine(line) {
    if (!this.started) {
      if (line === 'READY') { this.started = true; this.readyRes(); }
      return;
    }
    const q = this.queue.shift();
    if (q) { clearTimeout(q.t); q.resolve(line); }
  }

  kill(e) {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.idle);
    try { this.p.kill(); } catch { /* gone */ }
    if (!this.started) this.readyRej(e);
    for (const q of this.queue) { clearTimeout(q.t); q.reject(e); }
    this.queue = [];
    if (helper === this) helper = null;
  }

  // Stops itself after 2 idle minutes; the next request starts it again.
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kill(new Error('idle')), 120000);
    if (this.idle.unref) this.idle.unref();
  }

  async send(cmd, timeoutMs = 15000) {
    const t0 = setTimeout(() => this.kill(new Error('The capture helper did not start (30 s)')), 30000);
    try { await this.ready; } finally { clearTimeout(t0); }
    if (this.dead) throw new Error('The capture helper stopped');
    this.touch();
    return new Promise((resolve, reject) => {
      const q = { resolve, reject };
      q.t = setTimeout(() => this.kill(new Error('The capture helper timed out')), timeoutMs);
      this.queue.push(q);
      this.p.stdin.write(cmd + '\n');
    });
  }
}

function getHelper() {
  if (!supported) throw new Error('Window capture works on Windows only for now');
  if (!helper || helper.dead) helper = new Helper();
  return helper;
}

function stop() { if (helper) helper.kill(new Error('stopped')); }

async function listAll() {
  const out = await getHelper().send('LIST');
  if (!out.startsWith('[')) throw new Error(out.replace(/^ERR /, ''));
  return JSON.parse(out);
}

/** AI windows (plus watched ones), each with app/family/kind. */
async function listAi(watch) {
  return (await listAll()).map((w) => { const c = classify(w, watch); return c ? { ...w, ...c } : null; }).filter(Boolean);
}

const tmpFile = () => path.join(os.tmpdir(), `cortex-win-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);

/** JPEG of one window. Returns { buf } or { state: 'minimized' | 'gone' }. */
async function captureWindow(id, maxW = 960) {
  if (!/^\d{1,20}$/.test(String(id))) throw new Error('Bad window id');
  const out = tmpFile();
  try {
    const r = await getHelper().send(`CAP\t${id}\t${out}\t${Math.max(160, Math.min(2560, Number(maxW) || 960))}`);
    if (r === 'MIN') return { state: 'minimized' };
    if (r === 'GONE') return { state: 'gone' };
    if (!r.startsWith('OK')) throw new Error(r.replace(/^ERR /, '') || 'Capture failed');
    return { buf: fs.readFileSync(out), viaScreen: r === 'OK SCREEN' };
  } finally { fs.rm(out, { force: true }, () => {}); }
}

/** JPEG of the whole desktop through the running helper (much faster than a new PowerShell each frame). */
async function captureScreen(maxW = 1920) {
  const out = tmpFile();
  try {
    const r = await getHelper().send(`SCREEN\t${out}\t${maxW}`);
    if (r !== 'OK') throw new Error(r.replace(/^ERR /, '') || 'Capture failed');
    return fs.readFileSync(out);
  } finally { fs.rm(out, { force: true }, () => {}); }
}

/** For tests: average colour of a window's capture as [r, g, b], or 'minimized' / 'gone'. */
async function averageColor(id) {
  if (!/^\d{1,20}$/.test(String(id))) throw new Error('Bad window id');
  const r = await getHelper().send(`AVG\t${id}`);
  if (r === 'MIN') return 'minimized';
  if (r === 'GONE') return 'gone';
  if (!/^\d+,\d+,\d+$/.test(r)) throw new Error(r);
  return r.split(',').map(Number);
}

/** For tests: the helper's process id (to prove it is reused, and restarts after being killed). */
const helperPid = () => (helper && !helper.dead ? helper.p.pid : null);

module.exports = { supported, classify, listAll, listAi, captureWindow, captureScreen, averageColor, helperPid, stop };
