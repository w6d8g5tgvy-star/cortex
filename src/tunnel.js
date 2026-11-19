'use strict';
// Optional public HTTPS link via Cloudflare's free quick tunnels (needs `cloudflared` installed).
// Lets cloud AI apps (claude.ai custom connectors, ChatGPT, …) reach Cortex's MCP endpoint,
// and lets a paired phone connect from anywhere. Requests through the tunnel are never treated as local,
// so they always need a token.
const { spawn, execFile } = require('child_process');

class Tunnel {
  constructor(port) { this.port = port; this.proc = null; this.url = null; this.error = null; this.starting = false; }

  available() {
    const bin = process.env.CORTEX_CLOUDFLARED || 'cloudflared';
    return new Promise((res) => execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (e) => res(!e)));
  }

  status() { return { running: !!this.proc, starting: this.starting, url: this.url, error: this.error }; }

  start() {
    if (this.proc) return Promise.resolve(this.status());
    this.error = null; this.url = null; this.starting = true;
    const bin = process.env.CORTEX_CLOUDFLARED || 'cloudflared';
    return new Promise((resolve) => {
      const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = p;
      let done = false;
      const finish = () => { if (!done) { done = true; this.starting = false; resolve(this.status()); } };
      const scan = (d) => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m && !this.url) { this.url = m[0]; finish(); } };
      p.stdout.on('data', scan);
      p.stderr.on('data', scan);
      p.on('error', (e) => { this.error = e.code === 'ENOENT' ? 'cloudflared is not installed' : e.message; this.proc = null; finish(); });
      p.on('exit', (code) => { if (this.proc === p) { this.proc = null; this.url = null; if (!this.error) this.error = `Tunnel stopped (code ${code})`; } finish(); });
      setTimeout(() => { if (!this.url) { this.error = 'Timed out waiting for the tunnel address'; this.stop(); } finish(); }, 30000).unref();
    });
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } this.proc = null; } this.url = null; return this.status(); }
}

module.exports = { Tunnel };
