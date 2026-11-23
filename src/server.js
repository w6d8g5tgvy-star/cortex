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
const brief = require('./brief');
const settingsMod = require('./settings');
const screen = require('./screen');
const winmod = require('./windows');
const { Fetcher } = require('./fetcher');
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
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(vault, '.cortex', 'mcp-sessions.json'), 'utf8'));
    const cutoff = Date.now() - 14 * 864e5;
    for (const [k, s] of Object.entries(saved || {})) if (s && s.agent && Number(s.created) > cutoff) mcpSessions.set(k, s);
  } catch { /* first start */ }
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
  const doBackup = () => {
    if (conf().backups.daily) { try { backup.daily(vault); } catch { /* disk full etc. */ } }
    try { require('./experience').refreshAll(store); } catch { /* digests are best effort */ }
    try { const I = require('./intel'); I.failures.mine(store); I.engine.proposeFromFailures(store); I.engine.evaluate(store); } catch { /* best effort */ }
  };
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
  const smart = require('./smartsave/service').startService({ vault, store, conf: () => conf(), log: (e) => { try { store.log({ agent: 'cortex', ...e }); } catch { /* best effort */ } }, onChange: () => broadcast({ type: 'smartsave' }) });
  // Fetcher: this server is the one place research jobs run (agents' MCP processes only queue them).
  const fetcher = new Fetcher({ store, runner, broadcast: (ev) => broadcast(ev) });
  setTimeout(() => fetcher.pickUp(), 4000).unref();
  setInterval(() => fetcher.pickUp(), 5000).unref();
  // AI window list (refreshed at most every 2 s) and per-window captures shared by all viewers (1.2 s).
  const winState = { list: [], listAt: 0, listing: null, shots: new Map() };
  const aiWindows = async () => {
    if (Date.now() - winState.listAt < 2000) return winState.list;
    if (!winState.listing) winState.listing = winmod.listAi(conf().screen.watch || []).then((l) => { winState.list = l; winState.listAt = Date.now(); return l; }).finally(() => { winState.listing = null; });
    return winState.listing;
  };
  const windowShot = (id, maxW) => {
    const c = winState.shots.get(id);
    if (c && (c.pending || Date.now() - c.ts < 1200)) return c.pending || Promise.resolve(c.shot);
    const entry = { ts: 0, shot: null };
    entry.pending = winmod.captureWindow(id, maxW).then((shot) => { entry.shot = shot; entry.ts = Date.now(); return shot; }).finally(() => { entry.pending = null; });
    winState.shots.set(id, entry);
    if (winState.shots.size > 40) winState.shots.delete(winState.shots.keys().next().value);
    return entry.pending;
  };
  const tunnel = new PublicLink(port, () => conf().connector.provider);
  require('./mcp').setPhoneLinkProvider(async () => {
    const t = encodeURIComponent(tokenNow());
    const links = [];
    if (tunnel.url) links.push({ kind: 'public', label: 'Public link (works anywhere, also on mobile data)', url: `${tunnel.url.replace(/\/$/, '')}/?token=${t}#/live` });
    if (conf().remote.enabled) for (const a of lanAddresses(port).sort((a, b) => (b.kind === 'tailscale') - (a.kind === 'tailscale'))) links.push({ kind: a.kind, label: a.kind === 'tailscale' ? 'Tailscale (works anywhere with the Tailscale app)' : `Wi-Fi / home network (${a.iface})`, url: `${a.url}/?token=${t}#/live` });
    return { links, remoteEnabled: !!conf().remote.enabled };
  });
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
    if (tokenOk(h.startsWith('Bearer ') ? h.slice(7) : '') || tokenOk(u.searchParams.get('token')) || tokenOk(cookieToken(req))) return true;
    const d = deviceFor(req, u);
    return !!(d && d.kind === 'phone');
  };
  const deviceToken = (req, u) => { const h = req.headers.authorization || ''; return (h.startsWith('Bearer ') ? h.slice(7) : '') || u.searchParams.get('token') || cookieToken(req); };
  const deviceFor = (req, u) => { try { return require('./devices').authenticate(vault, deviceToken(req, u), { platform: req.headers['x-cortex-platform'], version: req.headers['x-cortex-version'] }); } catch { return null; } };
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
    try { await smart.beforeUpdate(); } catch { /* never block an update */ }
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
    if (!session) {
      // An app still using a session Cortex no longer knows (e.g. from before an older restart): keep ONE record for
      // that session id, so its calls share one card and name instead of a new "http-agent" card per call.
      session = { transport: connector ? 'connector' : 'http', local, agent: String(req.headers['x-agent-name'] || (connector ? 'connector app' : 'http-agent')).slice(0, 60), created: Date.now() };
      if (sid && /^[\w-]{8,100}$/.test(sid)) { session.id = 'mcp-' + sid.slice(0, 12); mcpSessions.set(sid, session); }
    }
    if (mcpSessions.size > 500) mcpSessions.delete(mcpSessions.keys().next().value);
    const before = session.model;
    const out = await mcp.handle(msg, session);
    if (isInit || session.model !== before) saveMcpSessions();
    if (!out) { res.writeHead(202, headers); return res.end(); }
    return send(res, 200, out, headers);
  }
  // Remember connected apps across restarts (updates restart Cortex). Without this, an app that keeps its
  // MCP session (claude.ai, ChatGPT) would show up as "http-agent" in activity and journals after a restart.
  // Access still needs the connector link or a local connection; this only keeps the app's name.
  function saveMcpSessions() {
    clearTimeout(saveMcpSessions.t);
    saveMcpSessions.t = setTimeout(() => {
      try {
        const keep = [...mcpSessions.entries()].slice(-200).filter(([, s]) => s.agent).map(([k, s]) => [k, { transport: s.transport, id: s.id, local: s.local, created: s.created, agent: s.agent, model: s.model }]);
        const f = path.join(vault, '.cortex', 'mcp-sessions.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify(Object.fromEntries(keep)));
        fs.renameSync(f + '.tmp', f);
      } catch { /* best effort */ }
    }, 500);
    if (saveMcpSessions.t.unref) saveMcpSessions.t.unref();
  }

  // ---------- REST API ----------
  // ---------- devices: pairing ----------
  async function handlePair(req, res, u) {
    const b = JSON.parse((await readBody(req)) || '{}');
    let r;
    try { r = require('./devices').redeem(vault, b.code, { name: b.name, platform: b.platform, version: b.version, ip: req.socket.remoteAddress }); } catch (e) { return send(res, 400, { error: e.message }); }
    store.log({ agent: 'you', action: 'device.paired', summary: `Paired ${r.device.kind === 'computer' ? 'computer' : 'phone'} "${r.device.name}"` });
    broadcast({ type: 'devices' });
    if (r.device.kind === 'phone') return send(res, 200, { device: r.device }, { 'Set-Cookie': `cortex_token=${encodeURIComponent(r.token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
    return send(res, 200, { device: r.device, token: r.token });
  }
  function sendPairPage(res, u) {
    const code = String(u.searchParams.get('code') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with Cortex</title>
<body style="font:16px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#1b1440,#05060d 60%);color:#e7e9f2">
<form id="f" style="width:min(360px,90vw);padding:28px;border-radius:18px;background:rgba(255,255,255,.04);border:1px solid rgba(124,160,255,.25)">
<h2 style="margin:0 0 6px">Pair this phone with Cortex</h2><p style="margin:0 0 18px;color:#9aa3c7;font-size:14px">Enter the code shown on your computer (Settings → Devices). Codes work once and last 10 minutes.</p>
<label style="font-size:13px;color:#9aa3c7">Pairing code</label><input id="c" value="${code}" autocomplete="one-time-code" style="width:100%;box-sizing:border-box;font:600 22px ui-monospace,monospace;letter-spacing:3px;padding:12px;margin:6px 0 14px;border-radius:10px;border:1px solid #3a4170;background:#0b0d1a;color:#fff;text-transform:uppercase">
<label style="font-size:13px;color:#9aa3c7">Name for this phone</label><input id="n" value="My phone" style="width:100%;box-sizing:border-box;font:16px system-ui;padding:12px;margin:6px 0 18px;border-radius:10px;border:1px solid #3a4170;background:#0b0d1a;color:#fff">
<button style="width:100%;padding:14px;border:0;border-radius:12px;font:600 16px system-ui;color:#fff;background:linear-gradient(90deg,#8b6bff,#47e3ff)">Pair</button><p id="m" style="min-height:22px;color:#ff8c8c;font-size:14px"></p></form>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const m=document.getElementById('m');m.style.color='#9aa3c7';m.textContent='Pairing…';
const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('c').value,name:document.getElementById('n').value,platform:navigator.platform})});
const j=await r.json().catch(()=>({}));if(r.ok){m.style.color='#5be3a0';m.textContent='Paired! Opening Cortex…';setTimeout(()=>location.href='/#/live',600)}else{m.style.color='#ff8c8c';m.textContent=j.error||'Could not pair'}}</script>`);
  }

  // ---------- agent jobs (phone launches, agent requests, paired computers) ----------
  const jobsMod = require('./jobs');
  const jobBrief = (j) => brief.buildBrief(store, { project: j.project, task: j.task, assignment: j.prompt, runId: j.id }).text;
  function startLocalJob(j) {
    const s = conf().agents;
    if (!s.enabled) return jobsMod.patch(vault, j.id, { status: 'error', step: 'Starting agents is turned off (Settings → Agent control on your computer).' });
    const proj = j.project ? store.get('projects/' + j.project) : null;
    const cwd = (proj && proj.meta.folder && agents.folderAllowed(proj.meta.folder, s.folders) && proj.meta.folder) || s.folders[0];
    if (!cwd || !agents.folderAllowed(cwd, s.folders)) return jobsMod.patch(vault, j.id, { status: 'error', step: 'Add an allowed folder first (Settings → Agent control).' });
    try {
      const pick = agents.pickAgent(proj && proj.meta, j.tool, j.model);
      const r = runner.launch({ ...pick, prompt: j.prompt, cwd, permission: s.permission, maxMinutes: s.maxMinutes, project: j.project, task: j.task, from: j.from });
      store.log({ agent: j.from, action: 'agent.start', summary: `Started ${pick.tool === 'codex' ? 'Codex' : 'Claude Code'} on this computer: ${String(j.prompt || j.task || '').slice(0, 120)}`, project: j.project, ref: j.id, device: 'This computer' });
      broadcast({ type: 'live' });
      return jobsMod.patch(vault, j.id, { status: 'running', runId: r.id, step: 'Running on this computer', startedAt: new Date().toISOString() });
    } catch (e) { return jobsMod.patch(vault, j.id, { status: 'error', step: e.message }); }
  }
  async function runner_bin_set(fn) { await runner.available(); fn.bin = runner.bin('claude'); }
  function notifyJob(j) {
    try { const ok = j.status === 'done'; require('./notify').add(vault, { kind: ok ? 'done' : 'failed', title: `${ok ? 'Finished' : j.status === 'stopped' ? 'Stopped' : 'Failed'} on ${j.deviceName}: ${String(j.prompt || j.task || '').slice(0, 80)}`, body: String(j.result || j.step || '').slice(0, 240), ref: j.id, project: j.project }); broadcast({ type: 'notify' }); } catch { /* optional */ }
  }
  /** Quality check when work is marked done (claims are not proof). Optionally keeps the task open if it fails. */
  function runQa(task, outcome, who) {
    try {
      const I = require('./intel');
      const res = I.qaCheck(store, task, { outcome: outcome || String(task.body || '').split('\n').slice(-6).join('\n') });
      const failed = res.checks.filter((c) => !c.ok);
      const block = conf().qa.block && res.verdict === 'fail';
      const patch = { qa: `${res.verdict}${failed.length ? ': ' + failed.map((c) => c.name).join(', ') : ''}`, qa_at: res.at };
      if (failed.length) patch.append = `**${res.at.slice(0, 16).replace('T', ' ')} · Cortex quality check: ${res.verdict.toUpperCase()}**${block ? ' (kept open)' : ''}\n${failed.map((c) => `- ${c.name}: ${c.detail}`).join('\n')}`;
      if (block) patch.status = 'doing';
      const r = store.update(task.id, patch);
      if (res.verdict !== 'pass') require('./notify').add(vault, { kind: 'qa', title: `Quality check ${res.verdict === 'fail' ? 'failed' : 'warning'}: ${task.title}`, body: failed.map((c) => c.detail).join(' · ').slice(0, 280), ref: task.id, project: task.meta.project });
      broadcast({ type: 'notify' });
      return r;
    } catch { return task; }
  }
  global.__cortexRunQa = runQa; // the MCP task_update in this process uses it too
  function tickJobs() {
    for (const j of jobsMod.list(vault, { limit: 100 })) {
      try {
        if (j.device === 'local' && j.status === 'queued') startLocalJob(j);
        else if (j.device === 'local' && j.status === 'running' && j.runId) {
          if (j.stopRequested && runner.running().includes(j.runId)) runner.stop(j.runId);
          const sx = sessions.get(vault, j.runId);
          if (sx && sx.status !== 'working') { const fin = jobsMod.patch(vault, j.id, { status: j.stopRequested ? 'stopped' : sx.status === 'error' ? 'error' : 'done', step: sx.step, result: sx.result, cost_usd: sx.cost_usd, finishedAt: new Date().toISOString() }); notifyJob(fin); }
        } else if (j.device !== 'local' && j.status === 'running' && Date.now() - Date.parse(j.updated || j.startedAt) > 15 * 60000) {
          jobsMod.patch(vault, j.id, { status: 'error', step: `Lost contact with ${j.deviceName} (no update for 15 minutes)` });
        }
      } catch { /* one bad job must not stop the rest */ }
    }
  }
  setInterval(tickJobs, 3000).unref();

  async function handleRunner(req, res, u, dev) {
    const b = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    if (u.pathname === '/api/runner/next' && req.method === 'POST') {
      const j = jobsMod.claimNext(vault, dev.id);
      if (!j) return send(res, 200, { job: null });
      sessions.upsert(vault, j.id, { agent: j.tool === 'codex' ? 'codex' : 'claude-code', title: String(j.prompt || j.task).slice(0, 140), status: 'working', step: `Starting on ${dev.name}…`, workspace: dev.name, launched: true, tool: j.tool, project: j.project, task: j.task, device: dev.name, from: j.from });
      broadcast({ type: 'live' });
      return send(res, 200, { job: { id: j.id, tool: j.tool, model: j.model, prompt: j.prompt, project: j.project, task: j.task, brief: jobBrief(j), ...(j.restore ? { restore: j.restore } : {}) } });
    }
    if (u.pathname === '/api/runner/smartsave-key' && req.method === 'POST') return send(res, 200, { key: smart.ss.recoveryKey() });
    if (u.pathname.startsWith('/api/runner/smartsave/')) {
      const key = u.pathname.slice('/api/runner/smartsave/'.length);
      const { KEY_RE } = require('./smartsave/targets');
      if (!KEY_RE.test(key)) return send(res, 400, { error: 'bad key' });
      const f = path.join(smart.ss.repo.dir, ...key.split('/'));
      if (req.method === 'HEAD') { try { return res.writeHead(fs.statSync(f).size > 0 ? 200 : 404).end(); } catch { return res.writeHead(404).end(); } }
      if (req.method === 'GET') { try { const b = fs.readFileSync(f); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length }); return res.end(b); } catch { return send(res, 404, { error: 'Not found' }); } }
      if (req.method === 'PUT') {
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > 60 * 1024 * 1024) return send(res, 413, { error: 'too large' }); chunks.push(c); }
        const buf = Buffer.concat(chunks);
        try { smart.ss.repo.open(buf); } catch (e) { return send(res, 400, { error: 'not a valid SmartSave object: ' + e.message }); } // only intact objects sealed with our key
        if (!fs.existsSync(f)) require('./smartsave/repo').writeAtomic(f, buf);
        broadcast({ type: 'smartsave' });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method' });
    }
    if (u.pathname === '/api/runner/smartsave-feed' && req.method === 'POST') {
      // snapshots made on THIS computer that the paired computer doesn't have yet (it keeps a copy: replication)
      const since = String(b.since || '');
      const items = [];
      for (const ws of smart.ss.repo.workspaces()) for (const id of smart.ss.repo.snapshotIds(ws)) if (id > since) items.push({ ws, id });
      items.sort((x, y) => (x.id < y.id ? -1 : 1));
      return send(res, 200, { items: items.slice(0, 200) });
    }
    if (u.pathname === '/api/runner/smartsave-ack' && req.method === 'POST') { smart.ss.ackReplica('paired:' + dev.name, b.items); broadcast({ type: 'smartsave' }); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/runner/update' && req.method === 'POST') {
      let j;
      try { j = jobsMod.report(vault, dev.id, b.id, b); } catch (e) { return send(res, 404, { error: e.message }); }
      const done = ['done', 'error', 'stopped'].includes(j.status);
      sessions.upsert(vault, j.id, { status: done ? (j.status === 'error' ? 'error' : 'done') : 'working', step: j.step, ...(j.result ? { result: j.result } : {}), ...(j.cost_usd ? { cost_usd: j.cost_usd } : {}) }, done ? { kind: 'status', text: `${j.status === 'done' ? '✓ Finished' : j.status === 'stopped' ? '■ Stopped' : '✗ ' + j.step} on ${dev.name}` } : undefined);
      if (done && !j.recorded) {
        notifyJob(j);
        store.log({ agent: j.tool === 'codex' ? 'codex' : 'claude-code', action: j.status === 'done' ? 'job.done' : 'job.failed', summary: `${j.status === 'done' ? 'Finished' : 'Ended (' + j.status + ')'} on ${dev.name}: ${String(j.prompt || j.task || '').slice(0, 100)}`, project: j.project, ref: j.id, device: dev.name });
        try { brief.recordOutcome(store, { project: j.project, task: j.task, agent: j.tool === 'codex' ? 'codex' : 'claude-code', prompt: j.prompt, status: j.status === 'done' ? 'done' : j.status, result: j.result || j.step, runId: j.id }); } catch { /* best effort */ }
        jobsMod.patch(vault, j.id, { recorded: true });
      }
      broadcast({ type: 'live' });
      return send(res, 200, { ok: true, stop: !!j.stopRequested });
    }
    return send(res, 404, { error: 'Not found' });
  }

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
      let r = store.update(id, patch);
      if (r.kind === 'task' && patch.status === 'done' && prevStatus !== 'done') { r = runQa(r, String(patch.append || ''), agent); try { require('./orchestra').requestVerification(store, r, agent); } catch { /* optional */ } }
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
    if (p === '/api/experience' && m === 'GET') {
      const exp = require('./experience');
      const slug = store.resolveProject(u.searchParams.get('project') || '');
      const r = exp.writeDigest(store, slug);
      return send(res, 200, { id: r.id, digest: r.digest, markdown: exp.markdown(r.digest, store.get('projects/' + slug).title) });
    }
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
    // ---- Fetcher: YouTube research + usefulness checker ----
    if (p === '/api/fetcher' && m === 'GET') {
      const ytdlp = !!(process.env.CORTEX_YTDLP || await require('./media').which('yt-dlp'));
      const forTask = u.searchParams.get('task');
      if (forTask) {
        const tf = require('./task-fetcher');
        const t = store.must(forTask);
        return send(res, 200, { task: t.id, enabled: tf.enabled(t), advice: tf.advice(store, t), jobs: tf.requests(store, t.id).map((j) => fetcher.summary(j)) });
      }
      const { USAGE } = require('./fetcher');
      return send(res, 200, { jobs: fetcher.list().slice(0, 40).map((j) => fetcher.summary(j)), settings: fetcher.conf(), ytdlp, usageLevels: Object.fromEntries(Object.entries(USAGE).map(([k, u]) => [k, { label: u.label, estimate: u.estimate, budget: u.budget, maxVideos: u.maxVideos, depth: u.depth, model: u.model, frames: u.frames }])), spentToday: fetcher.spentToday() });
    }
    if (p === '/api/fetcher/setup' && m === 'GET') {
      const setup = require('./setup');
      const st = await setup.check(runner);
      const cx = st.items.find((i) => i.key === 'codex');
      const codexModels = cx && cx.ok ? await require('./fetcher').codexModels(runner) : [];
      return send(res, 200, { ...st, codexModels, install: setup.status(), local });
    }
    if (p === '/api/fetcher/install' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      try { return send(res, 200, require('./setup').install(String(b.key || ''))); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/fetcher/install' && m === 'GET') return send(res, 200, require('./setup').status() || {});
    if (p === '/api/fetcher/job' && m === 'GET') {
      const j = fetcher.get(u.searchParams.get('id'));
      return j ? send(res, 200, j) : send(res, 404, { error: 'Not found' });
    }
    if (p === '/api/fetcher' && m === 'POST') {
      const b = await json();
      try {
        const project = b.project ? store.resolveProject(b.project) : undefined;
        const { topic, why, maxVideos, model, queries, depth, upload, length, sort, minViews, includeChannels, excludeChannels, related, planner, comments, links, frames, usage, budget, team, maxFrames } = b;
        return send(res, 201, fetcher.summary(fetcher.create({ topic, why, project, maxVideos, model, queries, depth, upload, length, sort, minViews, includeChannels, excludeChannels, related, planner, comments, links, frames, usage, budget, team, maxFrames, from: agent })));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/fetcher/approve' && m === 'POST') {
      const b = await json();
      try { return send(res, 200, fetcher.summary(b.reject ? fetcher.reject(b.id) : fetcher.approve(b.id))); } catch (e) { return send(res, 404, { error: e.message }); }
    }
    if (p === '/api/fetcher/teach' && m === 'POST') {
      const b = await json();
      try { return send(res, 200, fetcher.summary(fetcher.teachVideo(b.id, b.videoId))); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/fetcher/rescore' && m === 'POST') {
      const b = await json();
      try { return send(res, 200, fetcher.summary(fetcher.rescore(b.id))); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/fetcher' && m === 'DELETE') { fetcher.remove(u.searchParams.get('id')); return send(res, 200, { ok: true }); }
    if (p === '/api/fetcher/settings' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const cur = fetcher.conf();
      const next = {
        model: b.model !== undefined ? (String(b.model).trim() || 'sonnet') : cur.model,
        plannerModel: b.plannerModel !== undefined ? (String(b.plannerModel).trim() || 'haiku') : (cur.plannerModel || 'haiku'),
        maxVideos: b.maxVideos !== undefined ? Math.max(1, Math.min(12, Number(b.maxVideos) || 5)) : cur.maxVideos,
        team: b.team !== undefined ? Math.max(1, Math.min(4, Number(b.team) || 3)) : cur.team,
        threshold: b.threshold !== undefined ? Math.max(30, Math.min(95, Number(b.threshold) || 60)) : cur.threshold,
        autoRunAgentRequests: b.autoRunAgentRequests !== undefined ? !!b.autoRunAgentRequests : cur.autoRunAgentRequests,
        usage: ['low', 'medium', 'high', 'custom'].includes(b.usage) ? b.usage : cur.usage,
        perRunBudget: b.perRunBudget !== undefined ? Math.max(0, Math.min(100, Number(b.perRunBudget) || 0)) : cur.perRunBudget,
        dailyBudget: b.dailyBudget !== undefined ? Math.max(0, Math.min(1000, Number(b.dailyBudget) || 0)) : cur.dailyBudget,
        reviewer: b.reviewer !== undefined ? (b.reviewer === 'codex' ? 'codex' : 'claude') : (cur.reviewer || 'claude'),
        codexModel: b.codexModel !== undefined ? String(b.codexModel).trim().slice(0, 60) : (cur.codexModel || ''),
      };
      require('./agents').cleanModel(next.model); require('./agents').cleanModel(next.plannerModel);
      if (next.codexModel) require('./agents').cleanModel(next.codexModel);
      settingsMod.update(vault, { fetcher: next });
      return send(res, 200, next);
    }
    // ---- live view of each AI app's window (Windows) ----
    if (p === '/api/windows' && m === 'GET') {
      const s = conf().screen;
      if (!winmod.supported) return send(res, 200, { supported: false, enabled: s.enabled, windows: [], watch: s.watch || [] });
      if (!s.enabled) return send(res, 200, { supported: true, enabled: false, windows: [], watch: s.watch || [] });
      try {
        const list = await aiWindows();
        // A window counts as "showing agent work" only while an agent of that AI is active in Cortex
        // (working / waiting for you, or busy in the last 3 minutes). Background runs started by Cortex
        // have no window, so they don't count. Windows the user explicitly chose to watch always show.
        const busy = sessions.list(vault).filter((x) => !x.archived && !x.launched && (['working', 'needs-you'].includes(x.status) || Date.now() - Date.parse(x.updated) < 180000));
        const windows = list.map((w) => {
          const sess = w.family ? busy.filter((x) => agents.family(x.agent) === w.family).sort((a, b) => (a.updated < b.updated ? 1 : -1))[0] : null;
          return { id: w.id, app: w.app, family: w.family, kind: w.kind, title: w.title, process: w.process, minimized: w.minimized, w: w.w, h: w.h, active: w.kind === 'watched' || !!sess, session: sess ? sess.id : undefined };
        });
        return send(res, 200, { supported: true, enabled: true, windows, watch: s.watch || [] });
      } catch (e) { return send(res, 200, { supported: true, enabled: true, windows: [], watch: s.watch || [], error: e.message }); }
    }
    if (p === '/api/windows/all' && m === 'GET') {
      if (!localOnly()) return;
      if (!winmod.supported) return send(res, 200, { windows: [] });
      try { return send(res, 200, { windows: (await winmod.listAll()).map((w) => ({ process: w.process, title: w.title, minimized: w.minimized })) }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (p === '/api/windows/watch' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const proc = String(b.process || '').trim().slice(0, 80);
      if (!/^[\w .\-]+$/.test(proc)) return send(res, 400, { error: 'Pick a window to watch' });
      const title = String(b.title || '').trim().slice(0, 120);
      const cur = (conf().screen.watch || []).filter((w) => !(w.process.toLowerCase() === proc.toLowerCase() && (w.title || '') === title));
      const next = b.remove ? cur : [...cur, { process: proc, title, label: String(b.label || title || proc).slice(0, 60) }].slice(-20);
      settingsMod.update(vault, { screen: { watch: next } });
      winState.listAt = 0;
      store.log({ agent: 'you', action: 'settings', summary: `${b.remove ? 'Stopped watching' : 'Watching'} window: ${proc}${title ? ' · ' + title : ''}` });
      return send(res, 200, { watch: next });
    }
    if (p === '/api/windows/shot' && m === 'GET') {
      if (!conf().screen.enabled) return send(res, 403, { error: 'Screen sharing is turned off. Enable it in Settings on your computer.' });
      if (!winmod.supported) return send(res, 400, { error: 'Window capture works on Windows only for now' });
      const id = String(u.searchParams.get('id') || '');
      // Only AI windows (or ones the user chose to watch) can be captured: never any other window.
      const list = await aiWindows().catch(() => []);
      if (!list.some((w) => w.id === id)) return send(res, 404, { error: 'That window is not an AI app you are watching (it may have closed)' });
      try {
        const shot = await windowShot(id, Number(u.searchParams.get('w')) || 960);
        if (shot.state) return send(res, 409, { state: shot.state, error: shot.state === 'minimized' ? 'Minimized: restore the window to see it' : 'The window closed' });
        if (!local) {
          const nowT = Date.now();
          if (!handleApi.lastView || nowT - handleApi.lastView > 20000) broadcast({ type: 'screen-viewed', ip: req.socket.remoteAddress });
          handleApi.lastView = nowT;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': shot.buf.length });
        return res.end(shot.buf);
      } catch (e) { return send(res, 500, { error: e.message }); }
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

    // ---- lessons the safety check quarantined: review, approve (served with an "ask the user first" mark) or discard ----
    if (p === '/api/lessons/quarantine' && m === 'GET') {
      store.scan(false); // lessons may have been written by another process (an agent's own Cortex connection)
      const out = [];
      for (const r of store.list('note').filter((n) => n.meta.fetcher_quarantine)) {
        let q = []; try { q = JSON.parse(r.meta.fetcher_quarantine); } catch { q = []; }
        if (q.length) out.push({ id: r.id, title: r.title, items: q.map((t) => ({ name: t.name, when: t.when, do: t.do, reasons: t.safety_reasons || [], sources: (t.sources || []).map((x) => ({ title: x.title, url: x.url })) })) });
      }
      return send(res, 200, { lessons: out });
    }
    if (p === '/api/lessons/quarantine' && m === 'POST') {
      const b = await json();
      const r = store.must(b.id);
      let q = []; let act = [];
      try { q = JSON.parse(r.meta.fetcher_quarantine || '[]'); act = JSON.parse(r.meta.fetcher_lesson || '[]'); } catch { return send(res, 400, { error: 'Unreadable lesson' }); }
      const t = q.find((x) => x.name === b.name);
      if (!t) return send(res, 404, { error: 'Technique not found' });
      q = q.filter((x) => x !== t);
      if (b.action === 'approve') {
        act.push({ ...t, approved: true, safety: 'ask' });
        store.update(r.id, { fetcher_lesson: JSON.stringify(act), fetcher_quarantine: JSON.stringify(q), append: `> **${new Date().toISOString().slice(0, 10)}:** you approved the quarantined technique "${t.name}". Agents see it marked "ask the user first".` });
      } else store.update(r.id, { fetcher_quarantine: JSON.stringify(q) });
      store.log({ agent, action: b.action === 'approve' ? 'lesson.approved' : 'lesson.discarded', summary: `${b.action === 'approve' ? 'Approved' : 'Discarded'} quarantined technique "${t.name}" in ${r.title}`, ref: r.id });
      return send(res, 200, { ok: true, left: q.length });
    }

    // ---- automatic troubleshooting ----
    if (p === '/api/doctor' && m === 'GET') return send(res, 200, await require('./doctor').diagnose({ vault, store, conf, runner, tunnel, smart, claudeHooks, updater }));
    if (p === '/api/doctor/fix' && m === 'POST') { if (!localOnly()) return; const b = await json(); try { const r = await require('./doctor').fix(b.action, { vault, runner, tunnel, smart, claudeHooks, checkUpdates }); store.log({ agent, action: 'doctor.fix', summary: `Troubleshooting: ran "${b.action}"` }); return send(res, 200, r); } catch (e) { return send(res, 400, { error: e.message }); } }
    // ---- sandbox, prompt library, uploads, UX metrics, onboarding ----
    if (p === '/api/sandbox' && m === 'GET') return send(res, 200, { sandboxes: require('./sandbox').list() });
    if (p === '/api/sandbox' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json(); const sbx = require('./sandbox');
      try {
        if (b.action === 'create') { const slug = store.resolveProject(b.project); const root = smart.ss.projectRoot(slug) || (store.get('projects/' + slug) || { meta: {} }).meta.folder; if (!root) return send(res, 400, { error: 'This project has no folder' }); return send(res, 201, sbx.create(root, { name: b.name || slug })); }
        if (b.action === 'run') { if (!/^(node|npm|npx|python3?|pytest|git)$/.test(String(b.cmd))) return send(res, 400, { error: 'Allowed commands in the sandbox: node, npm, npx, python, pytest, git' }); return send(res, 200, await sbx.run(b.id, b.cmd, (b.args || []).map(String).slice(0, 30), { timeoutMs: Math.min(600000, Number(b.timeoutMs) || 120000) })); }
        if (b.action === 'diff') return send(res, 200, sbx.diff(b.id));
        if (b.action === 'apply') { const m2 = sbx.load(b.id); const slug = Object.keys(smart.ss.state().projects).find((k) => smart.ss.projectRoot(k) === m2.source) || null; const r = sbx.apply(b.id, { approved: b.approved === true, files: b.files, smart: smart.ss, project: slug }); store.log({ agent, action: 'sandbox.apply', summary: `Applied ${r.applied.length} sandbox file(s) to ${m2.source}${r.checkpoint ? ' (SmartSave checkpoint first)' : ''}` }); return send(res, 200, r); }
        if (b.action === 'destroy') return send(res, 200, sbx.destroy(b.id));
      } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 400, { error: 'unknown action' });
    }
    if (p === '/api/prompts' && m === 'GET') return send(res, 200, { prompts: require('./prompts').list(vault) });
    if (p === '/api/prompts' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json(); const P = require('./prompts');
      try {
        if (b.action === 'add') return send(res, 201, P.addVersion(vault, b.name, b.text, { note: b.note, by: agent }));
        if (b.action === 'compare') {
          // real model runs (cost money): uses the train ai tasks with hidden tests; capped by maxCostUsd
          const T = require('../experiments/train-ai/tasks'); const tasks = (b.tasks || ['journal']).map((k) => T[k]).filter(Boolean).map((t, i) => ({ id: (b.tasks || ['journal'])[i], input: t.prompt, score: (text) => t.score(([...String(text).matchAll(/```(?:js|javascript)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]).sort((x, y) => y.length - x.length)[0]) || text) }));
          const model = agents.cleanModel(b.model) || 'claude-haiku-5-5';
          const runner = (prompt) => new Promise((resolve) => require('child_process').execFile(runner.bin, ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--', prompt], { cwd: os.tmpdir(), timeout: 240000, maxBuffer: 20 << 20, env: { ...process.env, CORTEX_QUIET: '1' } }, (err, out) => { let j = {}; try { j = JSON.parse(out); } catch { j = {}; } const u2 = j.usage || {}; resolve({ text: String(j.result || ''), tokens: (u2.output_tokens || 0) + (u2.input_tokens || 0), ms: j.duration_ms || 0, cost: Number(j.total_cost_usd || 0) }); }));
          await runner_bin_set(runner);
          return send(res, 200, await P.compare(vault, b.name, { versions: b.versions, tasks, runner, trials: Math.min(5, Number(b.trials) || 3), maxCostUsd: Math.min(5, Number(b.maxCostUsd) || 0.25) }));
        }
      } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 400, { error: 'unknown action' });
    }
    if (p === '/api/upload' && m === 'POST') {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > require('./uploads').MAX) return send(res, 413, { error: 'Files can be up to 10 MB' }); chunks.push(c); }
      try { const r = require('./uploads').save(store, { name: decodeURIComponent(req.headers['x-filename'] || ''), data: Buffer.concat(chunks), project: req.headers['x-project'] || undefined, task: req.headers['x-task'] || undefined }); store.log({ agent, action: 'file.upload', summary: `Added file ${r.name} (${Math.round(r.size / 1024)} KB)`, project: req.headers['x-project'] || undefined }); return send(res, 201, r); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/ux' && m === 'POST') { if (!conf().ux.measure) return send(res, 200, { ok: false, measuring: false }); const b = await json(); return send(res, 200, require('./uploads').uxRecord(vault, b.events)); }
    if (p === '/api/ux' && m === 'GET') return send(res, 200, { ...conf().ux, report: require('./uploads').uxReport(vault) });
    if (p === '/api/ux/settings' && m === 'POST') { const b = await json(); const next = { ...conf().ux, ...(b.measure !== undefined ? { measure: !!b.measure } : {}), ...(b.onboarded !== undefined ? { onboarded: !!b.onboarded } : {}) }; settingsMod.save(vault, { ...conf(), ux: next }); return send(res, 200, next); }

    // ---- undo, recovery, search everywhere, permissions overview ----
    if (p === '/api/undo' && m === 'GET') return send(res, 200, { items: require('./undo').list(vault, 30), cannotUndo: require('./undo').CANNOT });
    if (p === '/api/undo' && m === 'POST') { const b = await json(); try { const r = require('./undo').undo(store, b.id); store.log({ agent, action: 'undo', summary: `Undid: ${r.what}` }); broadcast({ type: 'change' }); return send(res, 200, r); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/recovery' && m === 'GET') return send(res, 200, { items: require('./orchestra').recoverable(store, vault) });
    if (p === '/api/search/all' && m === 'GET') return send(res, 200, require('./orchestra').searchAll(store, vault, u.searchParams.get('q')));
    if (p === '/api/permissions' && m === 'GET') {
      const c = conf();
      return send(res, 200, {
        agents: { canStart: c.agents.enabled, folders: c.agents.folders, permissionMode: c.agents.permission, maxMinutes: c.agents.maxMinutes, phoneApprovals: c.agents.phoneApprovals, aiLaunchRequests: c.agents.autoApproveAgentLaunch ? 'auto-approved' : 'need your approval' },
        research: { agentRequests: c.fetcher.autoRunAgentRequests ? 'run automatically' : 'need your approval', dailyBudget: c.fetcher.dailyBudget, perRunBudget: c.fetcher.perRunBudget },
        devices: require('./devices').list(vault).map((d) => ({ name: d.name, kind: d.kind, online: d.online })), phoneAccess: c.remote.enabled,
        backups: (c.smartsave.targets || []).map((t) => ({ name: t.name, type: t.type })), routing: c.routing.mode, qaBlocks: c.qa.block,
        rule: 'Only you can change these, from this dashboard. Text in documents, websites, memories or agent messages can never change a permission.',
      });
    }
    // ---- timeline, feedback, preferences, shortcuts ----
    if (p === '/api/timeline' && m === 'GET') { const q = Object.fromEntries(u.searchParams); return send(res, 200, require('./userprefs').timeline(store, { ...q, limit: Math.min(300, Number(q.limit) || 100) })); }
    if (p === '/api/feedback' && m === 'POST') { const b = await json(); try { return send(res, 201, require('./userprefs').addFeedback(store, b, agent)); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/feedback' && m === 'GET') return send(res, 200, { items: require('./userprefs').listFeedback(vault).slice(0, 100) });
    if (p === '/api/preferences' && m === 'GET') return send(res, 200, require('./userprefs').preferences(store, conf()));
    if (p === '/api/preferences/forget' && m === 'POST') { const b = await json(); const pr = conf().preferences || { forgotten: [] }; const f = new Set(pr.forgotten || []); if (b.restore) f.delete(b.key); else f.add(String(b.key).slice(0, 40)); settingsMod.save(vault, { ...conf(), preferences: { ...pr, forgotten: [...f] } }); return send(res, 200, { forgotten: [...f] }); }
    if (p === '/api/shortcuts' && m === 'GET') return send(res, 200, { shortcuts: conf().shortcuts || [] });
    if (p === '/api/shortcuts' && m === 'POST') {
      const b = await json(); let list = (conf().shortcuts || []).slice();
      if (b.remove) list = list.filter((x) => x.name !== b.remove);
      else { const name = String(b.name || '').trim().slice(0, 40); const text = String(b.text || '').trim().slice(0, 300); if (!name || !text) return send(res, 400, { error: 'A shortcut needs a name and a command' }); list = list.filter((x) => x.name !== name); list.push({ name, text }); list = list.slice(-9); }
      settingsMod.save(vault, { ...conf(), shortcuts: list }); return send(res, 200, { shortcuts: list });
    }
    // ---- interface mode (Simple / Advanced) and hidden panels: any paired device may change its look ----
    if (p === '/api/ui' && m === 'POST') {
      const b = await json(); const cur = conf().ui || {};
      const next = { ...cur, ...(b.mode && ['simple', 'advanced'].includes(b.mode) ? { mode: b.mode } : {}), ...(Array.isArray(b.hidePanels) ? { hidePanels: b.hidePanels.filter((x) => /^[\w-]{1,30}$/.test(x)).slice(0, 20) } : {}) };
      settingsMod.save(vault, { ...conf(), ui: next }); return send(res, 200, next);
    }
    if (p === '/api/ui' && m === 'GET') return send(res, 200, conf().ui || { mode: 'advanced', hidePanels: [] });
    // ---- usage forecast (measured numbers only; never invents a provider limit) ----
    if (p === '/api/usage/forecast' && m === 'GET') return send(res, 200, require('./forecast').forecast(store, sessions.list(vault)));

    // ---- skill versions ----
    if (p === '/api/skills/versions' && m === 'GET') { try { return send(res, 200, require('./skill-versions').list(store, u.searchParams.get('name'))); } catch (e) { return send(res, 404, { error: e.message }); } }
    if (p === '/api/skills/versions' && m === 'POST') { if (!localOnly()) return; const b = await json(); try { const r = require('./skill-versions').setDefault(store, b.name, b.version); store.log({ agent, action: 'skill.version', summary: `Made version ${b.version} the default for skill "${b.name}"` }); return send(res, 200, r); } catch (e) { return send(res, 400, { error: e.message }); } }

    // ---- Intelligence (2.2): profiles, failures, improvements, routing ----
    if (p === '/api/intel' && m === 'GET') {
      const I = require('./intel');
      return send(res, 200, { profiles: I.profiles(store), failures: I.failures.all(vault).slice(-60).reverse(), failureStats: I.failures.stats(vault), improvements: I.engine.all(vault).slice(-40).reverse(), routing: { settings: conf().routing, recent: I.router.recent(vault, 15) } });
    }
    if (p === '/api/intel/route' && m === 'POST') { const b = await json(); return send(res, 200, require('./intel').router.route(store, { prompt: b.prompt, project: b.project ? store.resolveProject(b.project) : undefined, task: b.task, tool: b.tool })); }
    if (p === '/api/intel/improvements' && m === 'POST') {
      const b = await json(); const I = require('./intel');
      try {
        if (b.action === 'scan') { const mined = I.failures.mine(store); const props = I.engine.proposeFromFailures(store); return send(res, 200, { mined, proposed: props.length }); }
        if (b.action === 'apply') { if (!localOnly()) return; return send(res, 200, I.engine.apply(store, b.id, { by: agent, force: !!b.force })); }
        if (b.action === 'rollback') return send(res, 200, I.engine.rollback(store, b.id, { by: agent, reason: b.reason }));
        if (b.action === 'reject') return send(res, 200, I.engine.reject(vault, b.id, agent));
        if (b.action === 'test') return send(res, 200, I.engine.test(vault, b.id, b));
        return send(res, 400, { error: 'unknown action' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/intel/routing' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      if (b.mode && !['suggest', 'auto', 'manual'].includes(b.mode)) return send(res, 400, { error: 'mode must be suggest, auto or manual' });
      const r = { ...conf().routing, ...(b.mode ? { mode: b.mode } : {}), ...(b.model !== undefined ? { model: agents.cleanModel(b.model) || '' } : {}), ...(Array.isArray(b.never) ? { never: b.never.filter((x) => ['opus', 'sonnet', 'haiku'].includes(x)) } : {}) };
      settingsMod.save(vault, { ...conf(), routing: r });
      return send(res, 200, r);
    }
    // ---- notifications ----
    if (p === '/api/notifications' && m === 'GET') { const n = require('./notify'); const all = n.list(vault, { limit: 60 }); return send(res, 200, { unread: all.filter((x) => !x.read).length, items: all, kinds: n.KINDS, off: conf().notifications.off }); }
    if (p === '/api/notifications/read' && m === 'POST') { const b = await json(); return send(res, 200, require('./notify').markRead(vault, b.ids || 'all')); }
    if (p === '/api/notifications/settings' && m === 'POST') { if (!localOnly()) return; const b = await json(); settingsMod.save(vault, { ...conf(), notifications: { ...conf().notifications, off: (b.off || []).filter((k) => require('./notify').KINDS[k]) } }); return send(res, 200, { ok: true }); }
    // ---- emergency stop (any paired device: it only ever stops things) ----
    if (p === '/api/emergency-stop' && m === 'POST') {
      const stopped = { runs: 0, jobs: 0, research: 0 };
      for (const id of runner.running()) { if (runner.stop(id)) stopped.runs++; }
      for (const j of jobsMod.list(vault, { limit: 200 })) if (['needs-approval', 'queued', 'running'].includes(j.status)) { jobsMod.requestStop(vault, j.id); stopped.jobs++; }
      try { for (const j of fetcher.list()) if (['queued', 'running', 'needs-approval'].includes(j.status)) { (fetcher.stop || fetcher.reject).call(fetcher, j.id); stopped.research++; } } catch { /* optional */ }
      store.log({ agent, action: 'emergency.stop', summary: `Emergency stop: ${stopped.runs} agent runs, ${stopped.jobs} jobs and ${stopped.research} research runs stopped` });
      broadcast({ type: 'live' });
      return send(res, 200, stopped);
    }
    // ---- command center: plain English → action (sensitive ones need confirm: true) ----
    if (p === '/api/command' && m === 'POST') {
      const b = await json();
      const plan = require('./nlcmd').parse(b.text, { projects: store.list('project').map((x) => ({ title: x.title, slug: x.slug })) });
      if (plan.intent === 'unknown') return send(res, 200, plan);
      if (plan.confirm && !b.confirm) return send(res, 200, { ...plan, needsConfirm: true });
      const pr = plan.params;
      try {
        if (plan.intent === 'create-project') { const r = store.create('project', { title: pr.title }); return send(res, 200, { ...plan, done: true, go: '#/projects/' + r.slug }); }
        if (plan.intent === 'search') { const all = require('./orchestra').searchAll(store, vault, pr.q, { limit: 5 }); return send(res, 200, { ...plan, done: true, groups: all, results: [...all.projects, ...all.tasks, ...all.memories].slice(0, 8).map((x) => ({ ...x, kind: x.id.split('/')[0].replace(/s$/, '') })) }); }
        if (plan.intent === 'connect-device') return send(res, 200, { ...plan, done: true, go: '#/settings', note: `Open Settings → Devices → Add a ${pr.kind}` });
        if (plan.intent === 'troubleshoot') { const d = await require('./doctor').diagnose({ vault, store, conf, runner, tunnel, smart, claudeHooks, updater }); return send(res, 200, { ...plan, done: true, doctor: d, note: d.ok ? 'Everything looks fine.' : `${d.checks.filter((x) => !x.ok).length} problem(s) found: see Settings → Health check`, go: '#/settings' }); }
        if (plan.intent === 'improve') { const I = require('./intel'); const mined = I.failures.mine(store); const props = I.engine.proposeFromFailures(store); return send(res, 200, { ...plan, done: true, mined: mined.added, proposed: props.length, go: '#/agents' }); }
        if (plan.intent === 'organize') return send(res, 200, { ...plan, done: true, go: '#/memory', health: insights.health(store) });
        if (plan.intent === 'ui-mode') { settingsMod.save(vault, { ...conf(), ui: { ...conf().ui, mode: pr.mode } }); return send(res, 200, { ...plan, done: true, reload: true }); }
        if (plan.intent === 'save') { const r = pr.project ? { [pr.project]: smart.save(pr.project, 'saved by you') } : smart.saveAll('saved by you'); smart.kickUpload(); return send(res, 200, { ...plan, done: true, result: r }); }
        if (plan.intent === 'emergency-stop') { const r = await (await fetch(`http://127.0.0.1:${port}/api/emergency-stop`, { method: 'POST' })).json(); return send(res, 200, { ...plan, done: true, result: r }); }
        if (plan.intent === 'research') { const j = fetcher.create({ topic: pr.topic, project: pr.project || undefined, from: agent }); return send(res, 200, { ...plan, done: true, go: '#/fetcher', id: j.id }); }
        if (plan.intent === 'launch') {
          const devs = require('./devices').list(vault).filter((d) => d.kind === 'computer');
          const dev = pr.computer ? devs.find((d) => d.name.toLowerCase().includes(pr.computer.toLowerCase())) : null;
          if (pr.computer && !dev) return send(res, 400, { error: `No paired computer called "${pr.computer}"` });
          const route = require('./intel').router.route(store, { prompt: pr.prompt, project: pr.project, tool: pr.tool });
          const j = jobsMod.create(vault, { device: dev ? dev.id : 'local', deviceName: dev ? dev.name : 'This computer', tool: route.tool, model: conf().routing.mode === 'auto' ? route.model : undefined, prompt: pr.prompt, project: pr.project || undefined, from: agent });
          if (j.device === 'local') startLocalJob(j);
          return send(res, 200, { ...plan, done: true, job: j.id, route, go: '#/agents' });
        }
        if (plan.intent === 'continue') {
          const st = smart.ss.status().projects; const slug = pr.project || Object.keys(st).sort((a, c) => ((st[a].lastLocal || {}).time < (st[c].lastLocal || {}).time ? 1 : -1))[0];
          if (!slug) return send(res, 400, { error: 'Nothing saved to continue yet (turn on SmartSave for a project first)' });
          const latest = smart.ss.snapshots(slug, { limit: 1 })[0];
          const ctx = latest ? smart.ss.repo.getSnapshot(slug, latest.id).context : {};
          const prompt = `Continue the unfinished work on this project.${ctx && ctx.asked ? ` It was: ${ctx.asked}.` : ''}${ctx && ctx.step ? ` Last step: ${ctx.step}.` : ''}${ctx && ctx.task ? ` Task: ${ctx.task.title} (${ctx.task.id}).` : ''} Check the current state first, then carry on.`;
          const j = jobsMod.create(vault, { device: 'local', deviceName: 'This computer', tool: 'claude', prompt, project: slug, task: ctx && ctx.task ? ctx.task.id : undefined, from: agent });
          startLocalJob(j);
          return send(res, 200, { ...plan, done: true, job: j.id, project: slug, go: '#/live' });
        }
        if (plan.intent === 'setting') {
          if (!local) return send(res, 403, { error: 'Change settings on the computer running Cortex' });
          if (pr.smartsave) {
            const cur = conf().smartsave; const next = { ...cur, projects: { ...cur.projects } };
            if (pr.smartsave.intervalSec) next.intervalSec = Math.max(30, Math.min(3600, pr.smartsave.intervalSec));
            if (pr.smartsave.enabled !== undefined) { if (pr.smartsave.project) { next.projects[pr.smartsave.project] = { ...(next.projects[pr.smartsave.project] || {}), enabled: pr.smartsave.enabled }; if (pr.smartsave.enabled) next.enabled = true; } else next.enabled = pr.smartsave.enabled; }
            settingsMod.save(vault, { ...conf(), smartsave: next });
          } else {
            const c = conf(); const merged = { ...c };
            for (const [k, v] of Object.entries(pr)) if (['remote', 'updates', 'screen', 'agents'].includes(k)) merged[k] = { ...c[k], ...v };
            settingsMod.save(vault, merged);
          }
          store.log({ agent, action: 'settings.nl', summary: `Changed a setting by command: ${plan.summary}` });
          return send(res, 200, { ...plan, done: true });
        }
      } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 400, { error: 'Not supported yet' });
    }

    // ---- SmartSave: autosave + recovery ----
    if (p === '/api/smartsave/status' && m === 'GET') return send(res, 200, { ...smart.ss.status(), metrics: smart.metrics });
    if (p === '/api/smartsave/settings' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const cur = conf().smartsave;
      const next = { ...cur, projects: { ...cur.projects } };
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      for (const k of ['debounceSec', 'intervalSec', 'maxFileMB']) if (b[k] !== undefined) next[k] = Math.max(k === 'maxFileMB' ? 1 : 5, Math.min(k === 'intervalSec' ? 3600 : 500, Number(b[k]) || cur[k]));
      if (b.project) {
        const slug = store.resolveProject(b.project.id || b.project.slug);
        const pc = { ...(next.projects[slug] || {}) };
        if (b.project.enabled !== undefined) pc.enabled = !!b.project.enabled;
        if (b.project.root !== undefined) { const r = String(b.project.root || '').trim().replace(/^"|"$/g, ''); if (r && !fs.existsSync(r)) return send(res, 400, { error: `Folder not found: ${r}` }); pc.root = r || undefined; }
        if (Array.isArray(b.project.exclude)) pc.exclude = b.project.exclude.map(String).slice(0, 100);
        if (!pc.root && !(store.get('projects/' + slug) || { meta: {} }).meta.folder) return send(res, 400, { error: 'Choose the project folder first' });
        next.projects[slug] = pc;
      }
      settingsMod.save(vault, { ...conf(), smartsave: next });
      store.log({ agent, action: 'smartsave.settings', summary: `SmartSave settings changed${b.project ? ` for ${b.project.id || b.project.slug}` : ''}` });
      smart.tick();
      return send(res, 200, smart.ss.status());
    }
    if (p === '/api/smartsave/targets' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const id = 't-' + require('crypto').randomBytes(4).toString('hex');
      let t;
      if (b.type === 'folder') t = { id, type: 'folder', name: String(b.name || 'Backup folder').slice(0, 40), dir: path.resolve(String(b.dir || '').trim().replace(/^"|"$/g, '')) };
      else if (b.type === 's3') t = { id, type: 's3', name: String(b.name || 'Cloud storage').slice(0, 40), endpoint: String(b.endpoint || '').trim(), bucket: String(b.bucket || '').trim(), region: String(b.region || 'auto').trim(), accessKeyId: String(b.accessKeyId || '').trim(), prefix: String(b.prefix || 'cortex-smartsave').trim() };
      else return send(res, 400, { error: 'type must be folder or s3 (paired computers protect this one automatically)' });
      if (t.type === 'folder' && path.resolve(t.dir).startsWith(path.resolve(vault))) return send(res, 400, { error: 'Pick a folder outside the Cortex vault (ideally another drive or a cloud-synced folder).' });
      try { await require('./smartsave/targets').make(t, { [id]: b.secretAccessKey }).test(); } catch (e) { return send(res, 400, { error: `Could not write to it: ${e.message}` }); }
      if (b.secretAccessKey) smart.ss.setSecret(id, String(b.secretAccessKey));
      const cur = conf().smartsave;
      settingsMod.save(vault, { ...conf(), smartsave: { ...cur, targets: [...cur.targets, t] } });
      // queue the latest snapshot of every project for the new target
      const stt = smart.ss.state();
      for (const [ws, ps] of Object.entries(stt.projects)) if (ps.last) stt.queue.push({ target: id, ws, id: ps.last.id, added: new Date().toISOString() });
      smart.ss.saveState(stt); smart.kickUpload();
      store.log({ agent, action: 'smartsave.target', summary: `SmartSave: added backup target "${t.name}" (${t.type})` });
      return send(res, 201, { id, name: t.name, type: t.type });
    }
    if (p === '/api/smartsave/targets' && m === 'DELETE') {
      if (!localOnly()) return;
      const id = u.searchParams.get('id');
      const cur = conf().smartsave;
      settingsMod.save(vault, { ...conf(), smartsave: { ...cur, targets: cur.targets.filter((t) => t.id !== id) } });
      smart.ss.setSecret(id, null);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/smartsave/preview' && m === 'GET') { try { return send(res, 200, smart.ss.preview(store.resolveProject(u.searchParams.get('project')))); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === '/api/smartsave/save' && m === 'POST') {
      const b = await json();
      const slug = store.resolveProject(b.project);
      if (!smart.ss.enabledProjects().includes(slug)) return send(res, 400, { error: 'SmartSave is not turned on for this project' });
      let r; try { r = smart.ss.checkpoint(slug, { reason: 'saved by you', force: true }); } catch (e) { return send(res, e.code === 'BUSY' ? 409 : 400, { error: e.message }); }
      smart.kickUpload(); broadcast({ type: 'smartsave' });
      return send(res, 200, r);
    }
    if (p === '/api/smartsave/snapshots' && m === 'GET') {
      const slug = store.resolveProject(u.searchParams.get('project'));
      const from = u.searchParams.get('from') || 'local';
      if (from === 'local') return send(res, 200, { from, snapshots: smart.ss.snapshots(slug, { limit: Math.min(200, Number(u.searchParams.get('limit')) || 30) }) });
      try { return send(res, 200, { from, ids: (await smart.ss.remoteSnapshots(from, slug)).slice(0, 100) }); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/smartsave/restore' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      const slug = store.resolveProject(b.project);
      try {
        if (b.from && b.from !== 'local') await smart.ss.fetchFrom(b.from, slug, b.id);
        const root = smart.ss.projectRoot(slug) || path.join(os.homedir(), slug);
        const dest = b.dest ? path.resolve(String(b.dest)) : `${root.replace(/[\/]+$/, '')}-restored-${String(b.id).slice(0, 9)}`;
        if (b.preview) return send(res, 200, { dest, ...smart.ss.diff(slug, b.id, dest) });
        const r = smart.ss.restore(slug, b.id, { dest, overwrite: !!b.overwrite });
        store.log({ agent, action: 'smartsave.restore', summary: `SmartSave: restored ${slug} (${b.id}) into ${dest}: ${r.written} files written, ${r.conflicts.length} conflicts`, project: slug });
        return send(res, 200, r);
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/smartsave/recovery-key' && m === 'GET') { if (!localOnly()) return; return send(res, 200, { key: smart.ss.recoveryKey() }); }
    if (p === '/api/smartsave/prune' && m === 'POST') { if (!localOnly()) return; const b = await json(); try { return send(res, 200, smart.ss.prune({ dryRun: b.dryRun !== false })); } catch (e) { return send(res, 409, { error: e.message }); } }

    // ---- devices ----
    if (p === '/api/devices' && m === 'GET') return send(res, 200, { devices: require('./devices').list(vault) });
    if (p === '/api/devices/code' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      try {
        const c = require('./devices').createCode(vault, { kind: b.kind, name: b.name });
        const host = req.headers.host;
        return send(res, 201, { ...c, phoneUrl: `/pair?code=${encodeURIComponent(c.code)}`, runnerCommand: `node bin/cortex.js runner --hub <this Cortex's address> --code ${c.code}`, host });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/devices/rename' && m === 'POST') { if (!localOnly()) return; const b = await json(); try { return send(res, 200, require('./devices').rename(vault, b.id, b.name)); } catch (e) { return send(res, 404, { error: e.message }); } }
    if (p === '/api/devices/revoke' && m === 'POST') {
      if (!localOnly()) return;
      const b = await json();
      try { const d = require('./devices').revoke(vault, b.id); store.log({ agent, action: 'device.removed', summary: `Removed ${d.kind} "${d.name}"` }); broadcast({ type: 'devices' }); return send(res, 200, d); } catch (e) { return send(res, 404, { error: e.message }); }
    }
    // ---- agent jobs: start Claude Code / Codex on this computer or a paired one ----
    if (p === '/api/jobs' && m === 'GET') return send(res, 200, { jobs: jobsMod.list(vault, { limit: 40 }).map(({ key, ...j }) => j), computers: [{ id: 'local', name: 'This computer', online: true }, ...require('./devices').list(vault).filter((d) => d.kind === 'computer').map((d) => ({ id: d.id, name: d.name, online: d.online, lastSeen: d.lastSeen }))] });
    if (p === '/api/jobs' && m === 'POST') {
      const b = await json();
      if (!conf().agents.enabled) return send(res, 403, { error: 'Starting agents is turned off. Turn it on in Settings → Agent control on your computer.' });
      const devs = require('./devices').list(vault);
      const dev = b.device && b.device !== 'local' ? devs.find((d) => d.id === b.device && d.kind === 'computer') : null;
      if (b.device && b.device !== 'local' && !dev) return send(res, 400, { error: 'That computer is not paired.' });
      try {
        const restore = b.restore && /^[\w-]{1,80}$/.test(String(b.restore.id || '')) ? { ws: store.resolveProject(b.restore.project || b.project), id: String(b.restore.id) } : undefined;
        if (restore && !dev) return send(res, 400, { error: 'Continuing on another computer needs a paired computer.' });
        const j = jobsMod.create(vault, { device: dev ? dev.id : 'local', deviceName: dev ? dev.name : 'This computer', tool: b.tool || 'claude', model: b.model, prompt: b.prompt || (restore ? 'Continue the unfinished work in this folder. Read CORTEX-RESTORE.md first: it says what was being done, then carry on and report what you finished.' : ''), project: b.project ? store.resolveProject(b.project) : undefined, task: b.task, from: agent, restore });
        store.log({ agent, action: 'agent.launch', summary: `Asked ${j.deviceName} to run ${j.tool === 'codex' ? 'Codex' : 'Claude Code'}: ${String(j.prompt || j.task).slice(0, 120)}`, project: j.project, ref: j.id });
        if (j.device === 'local') startLocalJob(j);
        return send(res, 201, jobsMod.get(vault, j.id));
      } catch (e) { return send(res, e.code === 'DUPLICATE' ? 409 : 400, { error: e.message, job: e.job && e.job.id }); }
    }
    if (p === '/api/jobs/approve' && m === 'POST') {
      const b = await json();
      try {
        const j = b.reject ? jobsMod.reject(vault, b.id) : jobsMod.approve(vault, b.id);
        store.log({ agent, action: b.reject ? 'agent.launch.declined' : 'agent.launch.approved', summary: `${b.reject ? 'Declined' : 'Approved'} agent job: ${String(j.prompt || j.task).slice(0, 120)}`, project: j.project, ref: j.id });
        if (!b.reject && j.device === 'local' && j.status === 'queued') startLocalJob(j);
        return send(res, 200, jobsMod.get(vault, j.id));
      } catch (e) { return send(res, 404, { error: e.message }); }
    }
    if (p === '/api/jobs/stop' && m === 'POST') { const b = await json(); try { const j = jobsMod.requestStop(vault, b.id); if (j.device === 'local' && j.runId) runner.stop(j.runId); return send(res, 200, j); } catch (e) { return send(res, 404, { error: e.message }); } }

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
      if (u.pathname === '/api/pair' && req.method === 'POST') return await handlePair(req, res, u);
      if (u.pathname === '/pair' && req.method === 'GET') return sendPairPage(res, u);
      if (u.pathname.startsWith('/api/runner/')) {
        const dev = deviceFor(req, u);
        if (!dev || dev.kind !== 'computer') return send(res, 401, { error: 'This computer is not paired with Cortex (or was removed). Pair it again with a new code.' });
        return await handleRunner(req, res, u, dev);
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
