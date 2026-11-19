'use strict';
// Public HTTPS link so cloud AI apps (claude.ai custom connectors, ChatGPT, …) can reach Cortex's MCP
// endpoint, and a paired phone can connect from anywhere. Two providers:
//  - "tailscale": Tailscale Funnel. A PERMANENT address (https://<computer>.<tailnet>.ts.net). The funnel
//    lives in the Tailscale service, so it keeps working through Cortex restarts, updates and reboots.
//  - "cloudflare": Cloudflare quick tunnel. No account needed, but the address is random and changes
//    every time the tunnel restarts (every Cortex update, settings restart or reboot), which breaks
//    connectors saved in Claude/ChatGPT until the new link is pasted in.
// Requests through either are never treated as local, so they always need a token.
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const run = (bin, args, timeout = 10000) => new Promise((res) => {
  execFile(bin, args, { timeout, windowsHide: true }, (e, out, err) => res({ ok: !e, code: e ? e.code : 0, out: String(out || ''), err: String(err || '') }));
});

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

// ---------- Tailscale Funnel (permanent address) ----------
function tailscaleBin() {
  if (process.env.CORTEX_TAILSCALE) return process.env.CORTEX_TAILSCALE;
  const candidates = process.platform === 'win32'
    ? [`${process.env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return 'tailscale';
}

// Pure helper (tested): is the funnel serving https://<dns>:443 → this port?
function funnelServes(funnelJson, dns, port) {
  if (!funnelJson || !dns) return false;
  const key = `${dns}:443`;
  if (!funnelJson.AllowFunnel || !funnelJson.AllowFunnel[key]) return false;
  const handlers = (funnelJson.Web && funnelJson.Web[key] && funnelJson.Web[key].Handlers) || {};
  const root = handlers['/'];
  if (!root || !root.Proxy) return false;
  return new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(root.Proxy);
}

class Funnel {
  constructor(port) { this.port = port; this.url = null; this.error = null; this.enableUrl = null; this.starting = false; this.running = false; this.dns = null; this.loggedIn = null; }

  async available() { return (await run(tailscaleBin(), ['version'], 8000)).ok; }

  status() { return { running: this.running, starting: this.starting, url: this.url, error: this.error, enableUrl: this.enableUrl, dns: this.dns, loggedIn: this.loggedIn }; }

  // Read the real state from Tailscale (the funnel may have been set up or removed outside Cortex).
  async refresh() {
    const bin = tailscaleBin();
    const st = await run(bin, ['status', '--json'], 10000);
    let me = null;
    try { me = JSON.parse(st.out); } catch { /* not running */ }
    if (!st.ok || !me) { this.running = false; this.url = null; this.loggedIn = false; this.error = 'Tailscale is not running on this computer'; return this.status(); }
    this.loggedIn = me.BackendState === 'Running';
    this.dns = me.Self && me.Self.DNSName ? String(me.Self.DNSName).replace(/\.$/, '') : null;
    if (!this.loggedIn || !this.dns) { this.running = false; this.url = null; this.error = 'Sign in to Tailscale on this computer first'; return this.status(); }
    const fs2 = await run(bin, ['funnel', 'status', '--json'], 10000);
    let fj = {};
    try { fj = JSON.parse(fs2.out || '{}'); } catch { /* empty */ }
    this.running = funnelServes(fj, this.dns, this.port);
    this.url = this.running ? `https://${this.dns}` : null;
    if (this.running) { this.error = null; this.enableUrl = null; }
    return this.status();
  }

  async start() {
    this.starting = true; this.error = null;
    try {
      await this.refresh();
      if (this.running || !this.loggedIn) return this.status();
      // `tailscale funnel --bg <port>` saves the funnel in the Tailscale service (survives reboots).
      // If Funnel isn't allowed on the account yet, it prints a login.tailscale.com link and waits.
      const out = await new Promise((resolve) => {
        let text = '';
        const p = spawn(tailscaleBin(), ['funnel', '--bg', '--yes', String(this.port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve({ text, timedOut: true }); }, 25000);
        const scan = (d) => {
          text += String(d);
          if (/https:\/\/login\.tailscale\.com\/\S+/.test(text)) { clearTimeout(t); try { p.kill(); } catch { /* gone */ } resolve({ text, needsEnable: true }); }
        };
        p.stdout.on('data', scan); p.stderr.on('data', scan);
        p.on('error', (e) => { clearTimeout(t); resolve({ text: e.message, failed: true }); });
        p.on('exit', (code) => { clearTimeout(t); resolve({ text, code }); });
      });
      await this.refresh();
      if (!this.running) {
        const link = (out.text.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
        if (link) { this.enableUrl = link; this.error = 'Funnel is not turned on for your Tailscale account yet. Open the link, allow it, then press Check again.'; }
        else if (/access denied|permission|elevat|administrator/i.test(out.text)) this.error = 'Tailscale refused: run this once in an Administrator PowerShell: tailscale funnel --bg ' + this.port;
        else this.error = (out.text.trim().split('\n').pop() || 'Could not turn on Tailscale Funnel').slice(0, 300);
      }
    } finally { this.starting = false; }
    return this.status();
  }

  async stop() {
    await run(tailscaleBin(), ['funnel', '--https=443', 'off'], 15000);
    return this.refresh();
  }
}

// One public link, provider chosen in settings (connector.provider).
class PublicLink {
  constructor(port, getProvider) {
    this.quick = new Tunnel(port);
    this.funnel = new Funnel(port);
    this.getProvider = getProvider;
  }
  get provider() { return this.getProvider() === 'tailscale' ? 'tailscale' : 'cloudflare'; }
  get active() { return this.provider === 'tailscale' ? this.funnel : this.quick; }
  get url() { return this.active.url; }
  status() { return { provider: this.provider, permanent: this.provider === 'tailscale', ...this.active.status() }; }
  async start() {
    const target = this.active;
    const result = await target.start();
    // Keep the existing link usable while Funnel waits for account approval.
    if (target === this.funnel && this.active === target && result.running && result.url) this.quick.stop();
    return this.status();
  }
  async stop() { this.quick.stop(); if (this.provider === 'tailscale') await this.funnel.stop(); return this.status(); }
  async refresh() { if (this.provider === 'tailscale') await this.funnel.refresh(); return this.status(); }
  async tools() { const [cloudflared, tailscale] = await Promise.all([this.quick.available(), this.funnel.available()]); return { cloudflared, tailscale }; }
}

module.exports = { Tunnel, Funnel, PublicLink, funnelServes, tailscaleBin };
