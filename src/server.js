'use strict';
// HTTP server: dashboard UI, REST API, live events (SSE), phone access, screen view, updates,
// and the MCP Streamable HTTP endpoint.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { createMcp, VERSION } = require('./mcp');
const { snippets } = require('./snippets');
const sessions = require('./sessions');
const settingsMod = require('./settings');
const screen = require('./screen');
const updater = require('./updater');
const claudeHooks = require('./claude-hooks');
const agents = require('./agents');
const { AgentRunner } = agents;
const mind = require('./mind');
const { PublicLink } = require('./tunnel');
const skills = require('./skills');
const insights = require('./insights');
const templates = require('./templates');
const backup = require('./backup');
const semantic = require('./semantic');

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
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let errors = 0;
  let slowRequests = 0;
  const healthTimer = setInterval(() => {
    const lag = Math.round(eventLoop.percentile(99) / 1e6);
    eventLoop.reset();
    const findings = [];
    if (errors) findings.push('- HTTP server errors: ' + errors + '. Check the server logs for the cause.');
    if (slowRequests) findings.push('- Dashboard API responses taking more than a second: ' + slowRequests + '. Profile data loading.');
    if (lag > 100) findings.push('- 99th percentile event-loop delay: ' + lag + ' ms. Profile synchronous disk and indexing work.');
    errors = slowRequests = 0;
    if (!findings.length || !store.get('projects/cortex')) return;
    const title = 'Cortex runtime health';
    const body = '# ' + title + '\n\nFindings from the latest 15-minute interval with issues.\n\n' + findings.join('\n');
    const existing = store.get('notes/cortex/cortex-runtime-health');
    if (existing?.body.trim() === body.trim()) return;
    try {
      if (existing) store.update(existing.id, { body });
      else store.create('note', { title, body, type: 'reference', project: 'cortex' });
    } catch (error) { console.error('Cortex health report:', error.message); }
  }, 15 * 60e3).unref();
  const updateState = { checking: false, last: null, info: null, error: null, installing: false };
  const conf = () => settingsMod.load(vault);
  const tokenNow = () => cliToken || conf().remote.token;
  skills.seed(store);
  // daily backup + keep the meaning-search index fresh (both optional and best effort)
  const doBackup = () => { if (conf().backups.daily) { try { backup.daily(vault); } catch { /* disk full etc. */ } } };
  setTimeout(doBackup, 15000).unref();
  setInterval(doBackup, 3600e3).unref();
  let semState = { available: false, reason: 'checking…', indexed: 0 };
  let semTimer = null;
  const semIndex = async () => {
    const s = conf().search;
    if (!s.semantic) { semState = { available: false, reason: 'turned off' }; return; }
    semState = { ...(await semantic.status(s.model)), indexed: semState.indexed || 0 };
    if (semState.available) { try { await semantic.index(store, s.model); semState.indexed = Object.keys(JSON.parse(fs.readFileSync(path.join(vault, '.cortex', 'embeddings.json'), 'utf8')).items).length; } catch (e) { semState.reason = e.message; } }
  };
  setTimeout(semIndex, 5000).unref();
  store.on('change', () => { clearTimeout(semTimer); semTimer = setTimeout(semIndex, 15000); semTimer.unref(); });
  const runner = new AgentRunner(store);
  const tunnel = new PublicLink(port, () => conf().connector.provider);
  // Remember the last public link so a change (quick tunnels get a new random address on every restart)
  // is announced in the activity feed instead of silently breaking saved connectors.
  const noteLink = () => {
    const url = tunnel.url;
    if (!url) return;
    const s = conf();
    if (s.connector.lastUrl === url) return;
    const had = s.connector.lastUrl;
    settingsMod.update(vault, { connector: { lastUrl: url } });
    if (had) store.log({ agent: 'cortex', action: 'connector.link', summary: tunnel.status().permanent ? 'Connector link is now permanent (Tailscale). Paste it into Claude/ChatGPT once; it will not change again.' : 'Connector link CHANGED (quick tunnel restarted). Apps using the old link can no longer reach Cortex: copy the new one from Settings → Connect AI apps.' });
  };
  tunnel.refresh().catch(() => {});
  // keep the Cortex block in ~/.claude/CLAUDE.md / ~/.codex/AGENTS.md on the latest prompt (only where the user added it)
  try { const ins = require('./instructions'); for (const [k, v] of Object.entries(ins.status())) if (v === 'outdated') ins.install(k); } catch { /* optional */ }
  // self-heal Claude Code hooks written by older versions (PowerShell couldn't run them on Windows)
  try { if (claudeHooks.repair({ vault }).repaired) store.log({ agent: 'cortex', action: 'hooks.repair', summary: 'Repaired the Claude Code hooks so they run on this computer (old command line failed in PowerShell).' }); } catch { /* settings unreadable */ }
  if (conf().connector.tunnel) setTimeout(() => tunnel.start().then(() => { noteLink(); broadcast({ type: 'tunnel' }); }), 1500).unref();
  // runs that were going when Cortex last stopped can't be tracked any more
  for (const s of sessions.list(vault)) if (s.launched && s.status === 'working') sessions.upsert(vault, s.id, { status: 'error', step: 'Cortex restarted while this run was going; it may still be running in the background' });
  const broadcast = (ev) => { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const res of sse) res.write(data); };

  store.on('change', broadcast);
  setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 25000).unref();
  // watch live sessions written by other processes (stdio MCP servers, Claude Code hooks)
  let liveStamp = sessions.dirStamp(vault);
  const cmdStamp = () => { try { return fs.statSync(path.join(vault, '.cortex', 'commands')).mtimeMs; } catch { return 0; } };
  let lastCmd = cmdStamp();
  setInterval(() => {
    const s = sessions.dirStamp(vault); if (s !== liveStamp) { liveStamp = s; broadcast({ type: 'live' }); }
    const c = cmdStamp(); if (c !== lastCmd) { lastCmd = c; broadcast({ type: 'commands' }); }
  }, 700).unref();

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
    if (!origin) return true;
    try { const o = new URL(origin); return ['http:', 'https:'].includes(o.protocol) && o.host === req.headers.host; } catch { return false; }
  };
  const cookieToken = (req) => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)cortex_token=([^;]+)/); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; } };
  const tokenOk = (given, t = tokenNow()) => {
    if (!t || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const authorized = (req, u, allowConnector = false) => {
    if (isLocal(req)) return true;
    const h = req.headers.authorization || '';
    if (allowConnector && h.startsWith('Bearer ') && tokenOk(h.slice(7), conf().connector.token)) return true;
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
  async function handleMcp(req, res, connector = false) {
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
      mcpSessions.set(sid, { transport: connector ? 'connector' : 'http', id: 'mcp-' + sid.slice(0, 12), local: !connector && isLocal(req), created: Date.now() });
      headers['Mcp-Session-Id'] = sid;
    }
    let session = sid && mcpSessions.get(sid);
    const local = !connector && isLocal(req);
    if (session && (session.local !== local || session.transport !== (connector ? 'connector' : 'http'))) {
      return send(res, 403, { error: 'Invalid MCP session for this connection' });
    }
    if (!session) session = { transport: connector ? 'connector' : 'http', local, agent: String(req.headers['x-agent-name'] || 'http-agent').slice(0, 60) };
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
        mind: store.list('mind').map((r) => store.toJSON(r, { body: false })),
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
      const q = u.searchParams.get('q') || '';
      const f = { kind: u.searchParams.get('kind') || undefined, limit: 30 };
      const hits = semState.available ? await semantic.hybrid(store, q, f, conf().search.model) : store.search(q, f);
      return send(res, 200, hits.map((h) => ({ id: h.rec.id, kind: h.rec.kind, title: h.rec.title, snippet: h.snippet, score: h.score, semantic: !!h.semantic })));
    }
    // ---- insights, templates, history, backups ----
    if (p === '/api/health' && m === 'GET') return send(res, 200, insights.health(store));
    if (p === '/api/garden' && m === 'GET') return send(res, 200, insights.garden(store));
    if (p === '/api/garden/run' && m === 'POST') {
      const b = await json();
      const report = insights.garden(store);
      const text = `${insights.GARDEN_PROMPT}\n\nGardener report (JSON):\n${JSON.stringify(report).slice(0, 12000)}`;
      if (b.via === 'launch') {
        const s = conf().agents;
        if (!s.enabled || !s.folders[0]) return send(res, 403, { error: 'Turn on Settings → Agent control and add a folder to launch agents.' });
        return send(res, 201, runner.launch({ tool: 'claude', prompt: text, cwd: s.folders[0], permission: 'default', maxMinutes: 30, from: agent }));
      }
      return send(res, 201, { command: agents.createCommand(vault, { text, target: 'any', from: agent }) });
    }
    if (p === '/api/briefing' && m === 'GET') {
      const hours = Math.min(24 * 14, Math.max(1, Number(u.searchParams.get('hours')) || 24));
      return send(res, 200, insights.briefing(store, Date.now() - hours * 3600e3));
    }
    if (p === '/api/briefing/save' && m === 'POST') {
      const b = insights.briefing(store);
      const r = store.create('note', { title: `Daily briefing ${new Date().toISOString().slice(0, 10)}`, type: 'log', body: b.markdown, tags: ['briefing'] });
      return send(res, 201, { id: r.id });
    }
    if (p === '/api/templates' && m === 'GET') return send(res, 200, templates.TEMPLATES.map(({ id, name, description, color, instructions, tasks, notes }) => ({ id, name, description, color, instructions, tasks: tasks.length, notes: notes.length })));
    if (p === '/api/templates' && m === 'POST') {
      const b = await json();
      const pr = templates.createFromTemplate(store, b.template, { title: b.title, description: b.description, folder: b.folder });
      store.log({ agent, action: 'project.create', summary: `Created project "${pr.title}" from the ${b.template} template`, project: pr.slug });
      return send(res, 201, store.toJSON(pr));
    }
    if (p === '/api/history' && m === 'GET') {
      const id = u.searchParams.get('id') || '';
      const v = u.searchParams.get('version');
      if (v) return send(res, 200, { text: backup.readVersion(vault, id, v) });
      return send(res, 200, backup.versions(vault, id));
    }
    if (p === '/api/history/restore' && m === 'POST') {
      const b = await json();
      const text = backup.readVersion(vault, b.id, b.version);
      const { parse } = require('./frontmatter');
      const { meta, body } = parse(text);
      const r = store.update(b.id, { ...meta, body, quiet: true });
      store.log({ agent, action: 'restore', summary: `Restored an earlier version of "${r.title}"`, ref: r.id });
      return send(res, 200, store.toJSON(r));
    }
    if (p === '/api/backups' && m === 'GET') return send(res, 200, { backups: backup.listBackups(vault), daily: conf().backups.daily, semantic: { ...semState, model: conf().search.model, enabled: conf().search.semantic } });
    if (p === '/api/backups' && m === 'POST') { if (!localOnly()) return; return send(res, 201, backup.backupNow(vault)); }
    if (p === '/api/graph' && m === 'GET') return send(res, 200, store.graph());
    if (p === '/api/activity' && m === 'GET') return send(res, 200, store.recentActivity({ agent: u.searchParams.get('agent') || undefined, limit: Number(u.searchParams.get('limit')) || 200 }));
    if (p === '/api/activity' && m === 'POST') { const b = await json(); return send(res, 201, store.log({ ...b, agent: b.agent || agent })); }
    if (p === '/api/rescan' && m === 'POST') { store.scan(false); return send(res, 200, { ok: true, items: store.items.size }); }

    // ---- live agent sessions ----
    if (p === '/api/live' && m === 'GET') {
      const apDir = path.join(vault, '.cortex', 'approvals');
      let approvals = [];
      try { approvals = fs.readdirSync(apDir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(apDir, f), 'utf8')); } catch { return null; } }).filter((a) => a && a.status === 'pending' && Date.now() - new Date(a.ts).getTime() < 150000); } catch { /* none */ }
      return send(res, 200, { sessions: sessions.list(vault).map((s) => ({ ...s, events: s.events.slice(-25) })), screenEnabled: conf().screen.enabled, approvals });
    }
    if (p === '/api/approvals' && m === 'POST') {
      const b = await json();
      const f = path.join(vault, '.cortex', 'approvals', String(b.id || '').replace(/[^\w-]/g, '') + '.json');
      let cur;
      try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return send(res, 404, { error: 'That request is gone (it may have timed out)' }); }
      if (cur.status !== 'pending') return send(res, 409, { error: `Already ${cur.status}` });
      if (!['allow', 'deny'].includes(b.decision)) return send(res, 400, { error: 'decision must be allow or deny' });
      fs.writeFileSync(f, JSON.stringify({ ...cur, status: b.decision, note: b.note ? String(b.note).slice(0, 500) : undefined, decidedBy: agent, decidedAt: new Date().toISOString() }));
      store.log({ agent, action: b.decision === 'allow' ? 'approval.allow' : 'approval.deny', summary: `${b.decision === 'allow' ? 'Approved' : 'Denied'}: ${cur.summary}` });
      broadcast({ type: 'live' });
      return send(res, 200, { ok: true });
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

    // ---- organize agent sessions (chats) ----
    if (p === '/api/live' && m === 'PATCH') {
      const b = await json();
      if (!sessions.get(vault, b.id)) return send(res, 404, { error: 'Session not found' });
      const patch = {};
      for (const k of ['title', 'pinned', 'archived', 'notes']) if (b[k] !== undefined) patch[k] = b[k];
      if (b.project !== undefined) patch.project = b.project ? store.resolveProject(b.project) : null;
      if (b.tags !== undefined) patch.tags = String(b.tags).split(',').map((x) => x.trim()).filter(Boolean);
      sessions.upsert(vault, b.id, patch);
      broadcast({ type: 'live' });
      return send(res, 200, { ok: true });
    }

    // ---- skills ----
    if (p === '/api/skills' && m === 'GET') {
      return send(res, 200, store.list('skill').map((r) => ({ ...store.toJSON(r), installed: local ? skills.status(r) : undefined })));
    }
    if (p === '/api/skills/install' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const r = store.must(b.id);
      const out = b.action === 'uninstall' ? skills.uninstall(r, b.target) : skills.install(r, b.target);
      store.log({ agent, action: 'skill.' + (b.action || 'install'), summary: `${b.action === 'uninstall' ? 'Removed' : 'Installed'} skill "${r.title}" ${b.action === 'uninstall' ? 'from' : 'to'} ${skills.TARGETS[b.target].label}`, ref: r.id });
      return send(res, 200, out);
    }
    if (p === '/api/skills/import' && m === 'POST') { if (!localOnly()) return; const b = await json(); return send(res, 200, skills.importFrom(store, b.target)); }
    if (p === '/api/skills/zip' && m === 'GET') {
      const r = store.must(u.searchParams.get('id') || '');
      const buf = skills.skillZip(r);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${r.slug}.zip"`, 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (p === '/api/skills/chatgpt' && m === 'GET') return send(res, 200, { text: skills.chatgptText(store.must(u.searchParams.get('id') || '')) });

    // ---- mind ----
    if (p === '/api/mind' && m === 'POST') {
      const b = await json();
      const { rec, duplicate } = mind.add(store, { url: b.url, title: b.title, section: b.section, notes: b.notes, project: b.project || undefined, added_by: agent });
      if (!duplicate) store.log({ agent, action: 'mind.add', summary: `Added to Mind (${rec.meta.section}): ${rec.title}`, ref: rec.id });
      if (b.fetch && rec.meta.section !== 'write' && !duplicate) mind.fetchItem(store, rec.id).catch(() => {});
      return send(res, 201, { ...store.toJSON(rec, { body: false }), duplicate });
    }
    if (p === '/api/mind/fetch' && m === 'POST') {
      const b = await json();
      const r = await mind.fetchItem(store, b.id);
      return send(res, 200, store.toJSON(r, { body: false }));
    }
    if (p === '/api/mind/process' && m === 'POST') {
      const b = await json();
      const item = store.must(b.id);
      const ask = item.meta.section === 'write'
        ? `Write the article "${item.title}" for Mind item ${item.id}. Instructions: ${item.meta.notes || 'none given'}. Use project_brief/memory_search for context, then save the draft with mind_complete (draft).`
        : `Process Mind item ${item.id} ("${item.title}"): call mind_fetch if it is not fetched yet, read it with memory_get, then save a clear summary (key points, takeaways, notable quotes with timestamps) with mind_complete.`;
      const s = conf().agents;
      if (b.via === 'launch') {
        if (!s.enabled) return send(res, 403, { error: 'Starting agents is turned off. Enable it in Settings → Agent control on your computer.' });
        const folder = s.folders[0];
        if (!folder) return send(res, 400, { error: 'Add at least one allowed folder in Settings → Agent control.' });
        store.update(item.id, { status: 'processing' });
        const pick = agents.pickAgent(item.meta.project ? (store.get('projects/' + item.meta.project) || {}).meta : null, b.tool, b.model);
        return send(res, 201, runner.launch({ ...pick, prompt: ask, cwd: folder, permission: 'default', maxMinutes: 30, project: item.meta.project, from: agent }));
      }
      const c = agents.createCommand(vault, { text: ask, target: b.target || 'any', project: item.meta.project, from: agent });
      return send(res, 201, { command: c });
    }

    // ---- agent control ----
    if (p === '/api/agents' && m === 'GET') {
      const s = conf().agents;
      const available = await runner.available();
      const real = [...new Set([...store.activity.filter((a) => !['connect', 'settings', 'setup'].includes(a.action)).map((a) => a.agent), ...sessions.list(vault).map((x) => x.agent)].filter((a) => a && !/^(you|cortex)/.test(a)))];
      const projectFolders = store.list('project').filter((pr) => pr.meta.folder && fs.existsSync(pr.meta.folder)).map((pr) => ({ title: pr.title, folder: pr.meta.folder }));
      return send(res, 200, { enabled: s.enabled, folders: s.folders, permission: s.permission, available, running: runner.running(), commands: agents.listCommands(vault, { limit: 60 }), agents: real, projectFolders, vault, local,
        ready: { enabled: s.enabled, folders: s.folders.length > 0, tool: Object.values(available).some((x) => x.installed) } });
    }
    if (p === '/api/usage' && m === 'GET') return send(res, 200, require('./usage').report(sessions.list(vault)));
    if (p === '/api/agents/check' && m === 'POST') {
      const b = await json();
      const r = await runner.check(b.tool || 'claude');
      store.log({ agent, action: 'agent.check', summary: `${r.label}: ${r.found ? `found at ${r.path}` : 'not found'}${r.version ? ` (${r.version})` : ''}${r.signedIn === true ? ', signed in' : r.signedIn === false ? ', NOT signed in' : ''}` });
      return send(res, 200, r);
    }
    if (p === '/api/commands/run' && m === 'POST') {
      const s = conf().agents;
      if (!s.enabled) return send(res, 403, { error: 'Starting agents is turned off. Enable it in Settings → Agent control.' });
      const b = await json();
      const cmd = agents.listCommands(vault).find((c) => c.id === b.id);
      if (!cmd) return send(res, 404, { error: 'Command not found' });
      await runner.available();
      const proj = cmd.project ? store.get('projects/' + cmd.project) : null;
      const cwd = (proj && proj.meta.folder && agents.folderAllowed(proj.meta.folder, s.folders) && proj.meta.folder) || s.folders[0];
      if (!agents.folderAllowed(cwd, s.folders)) return send(res, 400, { error: 'Add an allowed folder first (Agents → Start an agent).' });
      const r = runner.launch({ ...agents.pickAgent(proj && proj.meta, b.tool, b.model), prompt: `${cmd.text}\n\n(This is Cortex command ${cmd.id}. When finished, call command_complete with id "${cmd.id}" and the result.)`, cwd, permission: s.permission, maxMinutes: s.maxMinutes, project: cmd.project, from: agent });
      try { const f = path.join(vault, '.cortex', 'commands', cmd.id + '.json'); fs.writeFileSync(f, JSON.stringify({ ...cmd, status: 'taken', takenBy: `Claude Code run ${r.id}`, takenAt: new Date().toISOString() })); fs.closeSync(fs.openSync(f.replace(/\.json$/, '.claim'), 'a')); } catch { /* best effort */ }
      broadcast({ type: 'live' });
      return send(res, 201, r);
    }
    if (p === '/api/agents/run' && m === 'POST') {
      await runner.available();
      const s = conf().agents;
      if (!s.enabled) return send(res, 403, { error: 'Starting agents is turned off. Enable it in Settings → Agent control on your computer.' });
      const b = await json();
      let cwd = b.folder;
      const proj = b.project ? store.get('projects/' + store.resolveProject(b.project)) : null;
      if (!cwd && proj && proj.meta.folder) cwd = proj.meta.folder;
      if (!cwd && b.resumeFrom) cwd = (sessions.get(vault, b.resumeFrom) || {}).cwd;
      if (!cwd) cwd = s.folders[0];
      if (!agents.folderAllowed(cwd, s.folders)) return send(res, 403, { error: `That folder is not in your allowed folders (Settings → Agent control): ${cwd || 'none'}` });
      let resume;
      let project = proj ? proj.slug : undefined;
      let task = b.task || undefined;
      if (b.resumeFrom) {
        const prev = sessions.get(vault, b.resumeFrom);
        if (!prev || !prev.claude_session) return send(res, 400, { error: 'This chat cannot be continued (it was not started by Cortex with Claude Code).' });
        resume = prev.claude_session; project = project || prev.project; task = task || prev.task;
      }
      let pick;
      try { pick = agents.pickAgent(proj && proj.meta, b.tool, b.model); } catch (e) { return send(res, 400, { error: e.message }); }
      const r = runner.launch({ ...pick, prompt: b.prompt, cwd, permission: s.permission, maxMinutes: s.maxMinutes, project, task, resume, continues: b.resumeFrom, from: agent });
      store.log({ agent, action: 'agent.start', summary: `Started ${pick.tool === 'codex' ? 'Codex' : 'Claude Code'}${pick.model ? ` (${pick.model})` : ''}: ${String(b.prompt || task || '').slice(0, 120)}`, project, ref: task });
      broadcast({ type: 'live' });
      return send(res, 201, r);
    }
    if (p === '/api/agents/stop' && m === 'POST') { const b = await json(); return send(res, 200, { stopped: runner.stop(b.id) }); }
    if (p === '/api/commands' && m === 'POST') {
      const b = await json();
      const c = agents.createCommand(vault, { text: b.text, target: b.target, project: b.project ? store.resolveProject(b.project) : undefined, from: agent });
      store.log({ agent, action: 'command.sent', summary: `Command for ${c.target === 'any' ? 'any agent' : c.target}: ${c.text.slice(0, 120)}`, project: c.project });
      return send(res, 201, c);
    }
    if (p === '/api/commands' && m === 'DELETE') { agents.deleteCommand(vault, u.searchParams.get('id')); store.emit('change', { type: 'commands' }); return send(res, 200, { ok: true }); }
    if (p === '/api/brief' && m === 'GET') {
      return send(res, 200, { text: require('./brief').buildBrief(store, { project: u.searchParams.get('project') || undefined, task: u.searchParams.get('task') || undefined, assignment: u.searchParams.get('assignment') || '' }).text });
    }
    if (p === '/api/tunnel' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      if (b.provider === 'tailscale' || b.provider === 'cloudflare') {
        if (b.provider !== tunnel.provider && b.provider !== 'tailscale' && b.action === 'start') await tunnel.stop();
        settingsMod.update(vault, { connector: { provider: b.provider } });
      }
      let st;
      if (b.action === 'check') st = await tunnel.refresh();
      else {
        settingsMod.update(vault, { connector: { tunnel: b.action === 'start' } });
        st = b.action === 'start' ? await tunnel.start() : await tunnel.stop();
      }
      noteLink();
      broadcast({ type: 'tunnel' });
      if (b.action === 'check') return send(res, 200, st);
      return send(res, st.error && b.action === 'start' ? 400 : 200, st);
    }

    // ---- settings: phone access, screen sharing, updates ----
    if (p === '/api/settings' && m === 'GET') {
      const s = conf();
      return send(res, 200, {
        local,
        updates: s.updates,
        screen: s.screen,
        remote: { enabled: s.remote.enabled, listening: host, ...(local ? { token: tokenNow(), addresses: [...lanAddresses(port), ...(tunnel.url ? [{ ip: new URL(tunnel.url).host, kind: 'public', url: tunnel.url }] : [])] } : {}) },
        supervised: !!process.env.CORTEX_SUPERVISED,
        claudeHooks: local ? claudeHooks.status() : undefined,
        instructions: local ? require('./instructions').status() : undefined,
        agents: { enabled: s.agents.enabled, folders: s.agents.folders, permission: s.agents.permission, maxMinutes: s.agents.maxMinutes, instructions: s.agents.instructions || '', saveGate: s.agents.saveGate !== false, phoneApprovals: !!s.agents.phoneApprovals },
        connector: local ? { token: s.connector.token, tunnel: tunnel.status(), provider: tunnel.provider, ...(await tunnel.tools()), localUrl: `http://127.0.0.1:${port}/mcp/${s.connector.token}` } : undefined,
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
      if (b.rotateConnector) patch.connector = { token: settingsMod.newToken() };
      if (b.agents) {
        const a = b.agents;
        patch.agents = {};
        if (a.enabled !== undefined) patch.agents.enabled = !!a.enabled;
        if (a.permission !== undefined) { if (!['default', 'acceptEdits', 'bypassPermissions'].includes(a.permission)) return send(res, 400, { error: 'Invalid permission mode' }); patch.agents.permission = a.permission; }
        if (a.maxMinutes !== undefined) patch.agents.maxMinutes = Math.max(5, Math.min(600, Number(a.maxMinutes) || 120));
        if (a.instructions !== undefined) patch.agents.instructions = String(a.instructions).slice(0, 20000);
        if (a.saveGate !== undefined) patch.agents.saveGate = !!a.saveGate;
        for (const k of ['claudePath', 'codexPath']) {
          if (a[k] === undefined) continue;
          const v = String(a[k]).trim().replace(/^"|"$/g, '');
          if (v && !fs.existsSync(v)) return send(res, 400, { error: `File not found: ${v}` });
          patch.agents[k] = v;
        }
        if (a.addFolder) {
          const f = path.resolve(String(a.addFolder).trim().replace(/^"|"$/g, ''));
          if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) return send(res, 400, { error: `Folder not found: ${f}` });
          patch.agents.folders = [...new Set([...(conf().agents.folders || []), f])];
        }
        if (a.phoneApprovals !== undefined) patch.agents.phoneApprovals = !!a.phoneApprovals;
        if (a.folders !== undefined) {
          const list = (Array.isArray(a.folders) ? a.folders : String(a.folders).split('\n')).map((x) => String(x).trim()).filter(Boolean);
          for (const f of list) if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) return send(res, 400, { error: `Folder not found: ${f}` });
          patch.agents.folders = list.map((f) => path.resolve(f));
        }
        if (a.enabled !== undefined) store.log({ agent: 'you', action: 'settings', summary: `Starting agents from Cortex ${a.enabled ? 'enabled' : 'disabled'}` });
      }
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
    if (p === '/api/instructions' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const ins = require('./instructions');
      const out = Object.keys(ins.TARGETS).map((t) => (b.action === 'uninstall' ? ins.uninstall(t) : ins.install(t)));
      store.log({ agent: 'you', action: 'settings', summary: b.action === 'uninstall' ? 'Removed the Cortex prompt from personal instruction files' : 'Added the Cortex prompt to personal instruction files' });
      return send(res, 200, out);
    }
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const u = new URL(req.url, 'http://localhost');
      const started = Date.now();
      res.on('finish', () => {
        if (res.statusCode >= 500) errors++;
        if (u.pathname.startsWith('/api/') && u.pathname !== '/api/events' && res.statusCode < 400 && Date.now() - started > 1000) slowRequests++;
      });
      if (!isAllowedOrigin(req)) return send(res, 403, { error: 'Forbidden origin' });
      if (u.pathname.startsWith('/mcp/')) {
        if (!tokenOk(decodeURIComponent(u.pathname.slice(5)), conf().connector.token)) return send(res, 401, { error: 'Unknown connector link' });
        return await handleMcp(req, res, true);
      }
      if (u.pathname === '/mcp') {
        if (!authorized(req, u, true)) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        return await handleMcp(req, res);
      }
      if (u.pathname.startsWith('/api/')) {
        if (!authorized(req, u)) return send(res, 401, { error: 'Not paired: scan the QR code in Cortex → Settings → Phone access' });
        return await handleApi(req, res, u);
      }
      return serveStatic(req, res, u);
    } catch (e) {
      const code = /not found/i.test(e.message) ? 404
        : /never overwrites|will not remove/i.test(e.message) ? 409
        : e instanceof SyntaxError || /invalid|required|unknown|empty|turned off|up to date/i.test(e.message) ? 400 : 500;
      if (code === 500) console.error('Cortex request failed:', e.message);
      if (res.headersSent || res.destroyed) return res.end();
      return send(res, code, { error: code === 500 ? 'Internal server error' : e.message });
    }
  });

  return new Promise((resolve, reject) => {
    const stopHealth = () => { clearInterval(healthTimer); eventLoop.disable(); };
    server.once('close', stopHealth);
    server.once('error', (error) => { stopHealth(); reject(error); });
    server.listen(port, host, () => { setTimeout(() => updater.confirm(), 8000).unref(); resolve(server); });
  });
}

module.exports = { startServer, lanAddresses };
