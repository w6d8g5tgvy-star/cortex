'use strict';
// HTTP server: dashboard UI, REST API, live events (SSE), phone access, screen view, updates,
// and the MCP Streamable HTTP endpoint.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createMcp, VERSION } = require('./mcp');
const { snippets } = require('./snippets');
const sessions = require('./sessions');
const settingsMod = require('./settings');
const screen = require('./screen');
const updater = require('./updater');
const claudeHooks = require('./claude-hooks');

const PUB = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function send(res, code, obj, headers = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function lanAddresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) || /tailscale/i.test(name);
      out.push({ ip: a.address, iface: name, kind: tailscale ? 'tailscale' : 'lan', url: `http://${a.address}:${port}` });
    }
  }
  return out.sort((a, b) => (a.kind === 'tailscale') - (b.kind === 'tailscale'));
}

function startServer({ store, port, host, token: cliToken }) {
  const vault = store.vault;
  const mcp = createMcp(store);
  const mcpSessions = new Map();
  const sse = new Set();
  const updateState = { checking: false, last: null, info: null, error: null, installing: false };
  const conf = () => settingsMod.load(vault);
  const tokenNow = () => cliToken || conf().remote.token;
  const broadcast = (ev) => { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const res of sse) res.write(data); };

  store.on('change', broadcast);
  setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 25000).unref();
  // watch live sessions written by other processes (stdio MCP servers, Claude Code hooks)
  let liveStamp = sessions.dirStamp(vault);
  setInterval(() => { const s = sessions.dirStamp(vault); if (s !== liveStamp) { liveStamp = s; broadcast({ type: 'live' }); } }, 700).unref();

  // A request is "local" only if it comes from this computer directly (not through a tunnel/proxy).
  const isLocal = (req) => {
    const ra = req.socket.remoteAddress || '';
    const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!loop) return false;
    if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['cf-connecting-ip'] || req.headers['x-real-ip']) return false;
    const h = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return LOCAL_HOSTS.has(h);
  };
  const isAllowedOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return true;
    try { const o = new URL(origin); return o.host === req.headers.host || LOCAL_HOSTS.has(o.hostname); } catch { return false; }
  };
  const cookieToken = (req) => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)cortex_token=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; };
  const tokenOk = (given) => {
    const t = tokenNow();
    if (!t || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const authorized = (req, u) => {
    if (isLocal(req)) return true;
    const h = req.headers.authorization || '';
    return tokenOk(h.startsWith('Bearer ') ? h.slice(7) : '') || tokenOk(u.searchParams.get('token')) || tokenOk(cookieToken(req));
  };
  const requestRestart = () => {
    if (!process.env.CORTEX_SUPERVISED) return false;
    broadcast({ type: 'restarting' });
    setTimeout(() => process.exit(75), 400);
    return true;
  };

  // ---------- updates ----------
  async function checkUpdates() {
    if (updateState.checking) return updateState;
    updateState.checking = true;
    try { updateState.info = await updater.check(conf().updates.source); updateState.error = updateState.info.error || null; } catch (e) { updateState.error = e.message; }
    updateState.checking = false;
    updateState.last = new Date().toISOString();
    broadcast({ type: 'update' });
    return updateState;
  }
  async function installUpdate() {
    if (!updateState.info || !updateState.info.available) await checkUpdates();
    if (!updateState.info || !updateState.info.available) throw new Error(updateState.error || 'Already up to date');
    updateState.installing = true;
    broadcast({ type: 'update' });
    try {
      const r = await updater.apply(updateState.info);
      store.log({ agent: 'cortex', action: 'update', summary: `Updated Cortex ${r.from} → ${r.to}` });
      const restarted = requestRestart();
      return { ...r, restarted };
    } finally { updateState.installing = false; }
  }
  async function autoUpdate() {
    const s = conf();
    await checkUpdates();
    if (s.updates.auto && updateState.info && updateState.info.available && process.env.CORTEX_SUPERVISED) {
      try { await installUpdate(); } catch (e) { updateState.error = e.message; }
    }
  }
  setTimeout(autoUpdate, 20000).unref();
  setInterval(autoUpdate, Math.max(1, Number(conf().updates.checkHours) || 6) * 3600e3).unref();

  // ---------- MCP ----------
  async function handleMcp(req, res) {
    if (req.method === 'GET') return send(res, 405, { error: 'Use POST for MCP requests' }, { Allow: 'POST, DELETE' });
    if (req.method === 'DELETE') { mcpSessions.delete(req.headers['mcp-session-id']); return send(res, 200, {}); }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });
    let msg;
    try { msg = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const msgs = Array.isArray(msg) ? msg : [msg];
    const isInit = msgs.some((m) => m && m.method === 'initialize');
    let sid = req.headers['mcp-session-id'];
    const headers = {};
    if (isInit) {
      sid = crypto.randomUUID();
      mcpSessions.set(sid, { transport: 'http', id: 'mcp-' + sid.slice(0, 12), local: isLocal(req), created: Date.now() });
      headers['Mcp-Session-Id'] = sid;
    }
    let session = sid && mcpSessions.get(sid);
    if (!session) session = { transport: 'http', local: isLocal(req), agent: String(req.headers['x-agent-name'] || 'http-agent').slice(0, 60) };
    if (mcpSessions.size > 500) mcpSessions.delete(mcpSessions.keys().next().value);
    const out = await mcp.handle(msg, session);
    if (!out) { res.writeHead(202, headers); return res.end(); }
    return send(res, 200, out, headers);
  }

  // ---------- REST API ----------
  async function handleApi(req, res, u) {
    const p = u.pathname;
    const m = req.method;
    const local = isLocal(req);
    const json = async () => { const t = await readBody(req); return t ? JSON.parse(t) : {}; };
    const agent = local ? 'you' : 'you (phone)';
    const localOnly = () => { if (!local) { send(res, 403, { error: 'This setting can only be changed on the computer running Cortex.' }); return false; } return true; };

    if (p === '/api/state' && m === 'GET') {
      return send(res, 200, {
        version: VERSION,
        vault: store.vault,
        local,
        stats: store.stats(),
        projects: store.list('project').map((r) => ({ ...store.toJSON(r), progress: store.projectStats(r.slug) })),
        tasks: store.list('task').map((r) => store.toJSON(r)),
        notes: store.list('note').map((r) => store.toJSON(r, { body: false })),
        activity: store.recentActivity({ limit: 200 }),
        liveCount: sessions.list(vault).filter((s) => ['working', 'needs-you'].includes(s.status)).length,
        update: updateState.info && updateState.info.available ? { latest: updateState.info.latest } : null,
      });
    }
    if (p === '/api/item' && m === 'GET') {
      const r = store.get(u.searchParams.get('id') || '');
      if (!r) return send(res, 404, { error: 'Not found' });
      return send(res, 200, { ...store.toJSON(r), broken: r.broken, backlinks: store.backlinks(r.id).map((b) => ({ id: b.id, kind: b.kind, title: b.title })) });
    }
    if (p === '/api/items' && m === 'POST') {
      const { kind, ...data } = await json();
      const r = store.create(kind, data);
      store.log({ agent, action: `${kind}.create`, summary: `Created ${kind} "${r.title}"`, ref: r.id, project: r.kind === 'project' ? r.slug : r.meta.project });
      return send(res, 201, store.toJSON(r));
    }
    if (p === '/api/items' && m === 'PATCH') {
      const { id, quiet, ...patch } = await json();
      const prevStatus = store.must(id).meta.status;
      const r = store.update(id, patch);
      if (!quiet) {
        const summary = patch.status && patch.status !== prevStatus ? `Moved "${r.title}" → ${patch.status}` : `Edited ${r.kind} "${r.title}"`;
        store.log({ agent, action: `${r.kind}.update`, summary, ref: r.id, project: r.kind === 'project' ? r.slug : r.meta.project });
      }
      return send(res, 200, store.toJSON(r));
    }
    if (p === '/api/items' && m === 'DELETE') {
      const r = store.remove(u.searchParams.get('id') || '');
      store.log({ agent, action: 'delete', summary: `Deleted ${r.kind} "${r.title}"`, project: r.meta.project });
      return send(res, 200, { deleted: r.id });
    }
    if (p === '/api/search' && m === 'GET') {
      return send(res, 200, store.search(u.searchParams.get('q') || '', { kind: u.searchParams.get('kind') || undefined, limit: 30 })
        .map((h) => ({ id: h.rec.id, kind: h.rec.kind, title: h.rec.title, snippet: h.snippet, score: h.score })));
    }
    if (p === '/api/graph' && m === 'GET') return send(res, 200, store.graph());
    if (p === '/api/activity' && m === 'GET') return send(res, 200, store.recentActivity({ agent: u.searchParams.get('agent') || undefined, limit: Number(u.searchParams.get('limit')) || 200 }));
    if (p === '/api/activity' && m === 'POST') { const b = await json(); return send(res, 201, store.log({ ...b, agent: b.agent || agent })); }
    if (p === '/api/rescan' && m === 'POST') { store.scan(false); return send(res, 200, { ok: true, items: store.items.size }); }

    // ---- live agent sessions ----
    if (p === '/api/live' && m === 'GET') {
      return send(res, 200, { sessions: sessions.list(vault).map((s) => ({ ...s, events: s.events.slice(-25) })), screenEnabled: conf().screen.enabled });
    }
    if (p === '/api/live' && m === 'DELETE') { sessions.remove(vault, u.searchParams.get('id')); broadcast({ type: 'live' }); return send(res, 200, { ok: true }); }
    if (p === '/api/live/message' && m === 'POST') {
      const b = await json();
      if (!String(b.text || '').trim()) return send(res, 400, { error: 'Message is empty' });
      const msg = sessions.sendMessage(vault, b.session, b.text, agent);
      sessions.upsert(vault, b.session, {}, { kind: 'message', text: `💬 You: ${String(b.text).slice(0, 300)}` });
      broadcast({ type: 'live' });
      return send(res, 201, msg);
    }
    if (p === '/api/live/snap' && m === 'GET') {
      const f = sessions.snapshotFile(vault, u.searchParams.get('id'));
      if (!f || !fs.existsSync(f.file)) return send(res, 404, { error: 'No snapshot' });
      res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'no-store' });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (p === '/api/screen' && m === 'GET') {
      if (!conf().screen.enabled) return send(res, 403, { error: 'Screen sharing is turned off. Enable it in Settings on your computer.' });
      const buf = await screen.captureCached();
      if (!local) {
        const ip = req.socket.remoteAddress;
        const nowT = Date.now();
        if (!handleApi.lastView || nowT - handleApi.lastView > 20000) broadcast({ type: 'screen-viewed', ip });
        handleApi.lastView = nowT;
      }
      res.writeHead(200, { 'Content-Type': sessions.sniffMime(buf) || 'image/png', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      return res.end(buf);
    }

    // ---- settings: phone access, screen sharing, updates ----
    if (p === '/api/settings' && m === 'GET') {
      const s = conf();
      return send(res, 200, {
        local,
        updates: s.updates,
        screen: s.screen,
        remote: { enabled: s.remote.enabled, listening: host, ...(local ? { token: tokenNow(), addresses: lanAddresses(port) } : {}) },
        supervised: !!process.env.CORTEX_SUPERVISED,
        claudeHooks: local ? claudeHooks.status() : undefined,
      });
    }
    if (p === '/api/settings' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const before = conf();
      const patch = {};
      if (b.updates) patch.updates = { auto: b.updates.auto !== undefined ? !!b.updates.auto : undefined, source: b.updates.source !== undefined ? String(b.updates.source).trim() : undefined };
      if (b.screen) patch.screen = { enabled: !!b.screen.enabled };
      if (b.remote && b.remote.enabled !== undefined) patch.remote = { enabled: !!b.remote.enabled };
      if (b.rotateToken) patch.remote = { ...(patch.remote || {}), token: settingsMod.newToken() };
      const s = settingsMod.update(vault, patch);
      if (patch.screen && patch.screen.enabled !== before.screen.enabled) store.log({ agent: 'you', action: 'settings', summary: `Screen sharing ${s.screen.enabled ? 'enabled' : 'disabled'}` });
      let restarting = false;
      if (patch.remote && patch.remote.enabled !== undefined && patch.remote.enabled !== before.remote.enabled) {
        store.log({ agent: 'you', action: 'settings', summary: `Phone access ${s.remote.enabled ? 'enabled' : 'disabled'}` });
        restarting = requestRestart();
      }
      if (patch.updates && patch.updates.source !== undefined) updateState.info = null;
      return send(res, 200, { ok: true, restarting, needsManualRestart: patch.remote && !restarting && patch.remote.enabled !== before.remote.enabled });
    }
    if (p === '/api/update' && m === 'GET') return send(res, 200, { current: VERSION, ...updateState, pending: updater.readPending() });
    if (p === '/api/update/check' && m === 'POST') { if (!localOnly()) return; return send(res, 200, await checkUpdates()); }
    if (p === '/api/update/apply' && m === 'POST') { if (!localOnly()) return; return send(res, 200, await installUpdate()); }
    if (p === '/api/restart' && m === 'POST') { if (!localOnly()) return; return send(res, 200, { restarting: requestRestart() }); }
    if (p === '/api/integrations/claude-code' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const r = b.action === 'uninstall' ? claudeHooks.uninstall() : claudeHooks.install({ vault });
      return send(res, 200, r);
    }

    if (p === '/api/config' && m === 'GET') {
      return send(res, 200, { version: VERSION, vault: store.vault, port, host, tokenRequired: !!cliToken, ...snippets({ vault: store.vault, port, host, token: cliToken }) });
    }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\ndata: {"type":"hello"}\n\n');
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }
    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(req, res, u) {
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/manifest.webmanifest') {
      const man = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
      if (!isLocal(req) && authorized(req, u)) man.start_url = `/?token=${encodeURIComponent(tokenNow())}#/live`;
      res.writeHead(200, { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(man));
    }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    if (rel === '/index.html' && !isLocal(req) && !authorized(req, u)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:32px;background:#0b0d14;color:#e7e9f2"><h2>Cortex</h2><p>This device is not paired. On your computer, open Cortex → Settings → Phone access and scan the QR code.</p></body>');
    }
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
      // pairing: remember the token in an HttpOnly cookie so images, events and API calls all work
      const t = u.searchParams.get('token');
      if (t && tokenOk(t)) headers['Set-Cookie'] = `cortex_token=${encodeURIComponent(t)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (!isAllowedOrigin(req)) return send(res, 403, { error: 'Forbidden origin' });
      if (u.pathname === '/mcp') {
        if (!authorized(req, u)) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        return await handleMcp(req, res);
      }
      if (u.pathname.startsWith('/api/')) {
        if (!authorized(req, u)) return send(res, 401, { error: 'Not paired: scan the QR code in Cortex → Settings → Phone access' });
        return await handleApi(req, res, u);
      }
      return serveStatic(req, res, u);
    } catch (e) {
      const code = /not found/i.test(e.message) ? 404 : /invalid|required|unknown|empty|turned off|up to date/i.test(e.message) ? 400 : 500;
      return send(res, code, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { setTimeout(() => updater.confirm(), 8000).unref(); resolve(server); });
  });
}

module.exports = { startServer, lanAddresses };
