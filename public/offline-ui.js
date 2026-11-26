// Cortex 2.3: offline mode (checklist #38). When this device can't reach Cortex, the saved copy is shown (see sw.js)
// and supported changes are queued here and sent when the connection returns:
//   new tasks and memories, and task edits (status, priority, title…).
// A queued edit carries the version it was made on; if the item was changed elsewhere meanwhile, the server refuses
// it (409) and you're shown what wasn't applied instead of silently overwriting newer work.
(() => {
  const KEY = 'cortex.offlineQueue'; const DONE = 'cortex.offlineProblems'; const SEEN = 'cortex.lastOnline';
  const NEEDS_NET = 'agents, Chat, Fetcher, running workflows, the file editor and settings';
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: queue lives in memory only */ mem[k] = v; } };
  const mem = {};
  const queue = () => mem[KEY] || load(KEY);
  const problems = () => mem[DONE] || load(DONE);
  let offline = false; let syncing = false;

  const css = `.off-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:75;max-width:min(680px,94vw);padding:9px 14px;border-radius:12px;font-size:12.5px;line-height:1.45;background:#2a2238;border:1px solid #ffc35c;color:#ffe7b8;box-shadow:0 10px 40px rgba(0,0,0,.5)}
  .off-bar b{color:#fff}.off-bar button{margin-left:8px;background:none;border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;padding:2px 8px;cursor:pointer;font-size:12px}
  .off-bar.ok{border-color:#3ddc97;background:#13261f;color:#c9f5e0}.off-bar.bad{border-color:#ff7a90;background:#2b1720;color:#ffd0d8}
  @media (max-width:820px){.off-bar{bottom:76px}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  let bar = null;
  function banner() {
    const q = queue(); const pr = problems();
    const text = offline
      ? `<b>Offline.</b> Showing the copy saved on this device${localStorage.getItem(SEEN) ? ` (from ${new Date(Number(localStorage.getItem(SEEN))).toLocaleString()})` : ''}. New tasks, memories and task changes are kept and sent when you're back${q.length ? ` (<b>${q.length}</b> waiting)` : ''}. Needs a connection: ${NEEDS_NET}.`
      : q.length ? `Sending ${q.length} change(s) made while offline…`
        : pr.length ? `<b>${pr.length} offline change(s) weren't applied</b>: ${pr.slice(0, 3).map((x) => esc(x.why)).join(' · ')}<button id="off-ok">OK</button>` : '';
    if (!text) { if (bar) { bar.remove(); bar = null; } return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'off-bar'; document.body.appendChild(bar); }
    bar.className = 'off-bar' + (offline ? '' : pr.length && !q.length ? ' bad' : ' ok');
    bar.innerHTML = text;
    const okb = bar.querySelector('#off-ok'); if (okb) okb.onclick = () => { store(DONE, []); banner(); };
  }
  function setOffline(v) { if (offline === v) return; offline = v; banner(); if (!v) sync(); }

  // ---- queue supported changes when the network is down ----
  const orig = window.api;
  function queueable(path, opts) {
    const m = (opts.method || 'GET').toUpperCase();
    return path === '/api/items' && (m === 'POST' || m === 'PATCH');
  }
  function itemById(id) { return (S.tasks || []).find((t) => t.id === id) || (S.notes || []).find((n) => n.id === id) || null; }
  window.api = async function api(path, opts = {}) {
    try {
      const r = await orig(path, opts);
      if (offline && (opts.method || 'GET').toUpperCase() !== 'GET') setOffline(false); // a change went through: we're online (GETs may come from the saved copy)
      if (path === '/api/state') { try { localStorage.setItem(SEEN, String(Date.now())); } catch { /* private */ } }
      return r;
    } catch (e) {
      const network = e instanceof TypeError || /offline and this page|Failed to fetch|NetworkError|Load failed/i.test(e.message);
      if (!network) throw e;
      setOffline(true);
      if (!queueable(path, opts)) throw new Error(`You're offline. This needs a connection to Cortex.`);
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : { ...(opts.body || {}) };
      const m = (opts.method || 'GET').toUpperCase();
      const entry = { id: 'q-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), path, method: m, body, ts: Date.now() };
      if (m === 'PATCH') {
        const cur = itemById(body.id);
        if (String(body.id || '').startsWith('offline-')) { // editing something created offline: fold into the queued create
          const q = queue(); const c = q.find((x) => x.tempId === body.id); if (c) { const { id, ...rest } = body; Object.assign(c.body, rest); store(KEY, q); }
          if (cur) Object.assign(cur, body); banner(); toast('Saved on this device: it will be sent when you\'re back online'); return { ...(cur || {}), queued: true };
        }
        if (cur && cur.updated) entry.body.ifUpdated = cur.updated;
        if (cur) Object.assign(cur, Object.fromEntries(Object.entries(body).filter(([k]) => !['id', 'ifUpdated', 'append'].includes(k))));
      } else {
        entry.tempId = 'offline-' + entry.id;
        const fake = { ...body, id: entry.tempId, title: body.title || 'Untitled', status: body.status || 'todo', priority: body.priority || 'medium', created: new Date().toISOString(), updated: new Date().toISOString(), offline: true };
        if (body.kind === 'task') (S.tasks || (S.tasks = [])).unshift(fake);
        if (body.kind === 'note') (S.notes || (S.notes = [])).unshift(fake);
      }
      const q = queue(); q.push(entry); store(KEY, q); banner();
      toast('Saved on this device: it will be sent when you\'re back online');
      return { ...(itemById(entry.tempId || body.id) || body), queued: true };
    }
  };

  async function sync() {
    if (syncing || offline) return; const q = queue(); if (!q.length) return banner();
    syncing = true; banner(); const pr = problems(); const map = {};
    try {
      while (queue().length) {
        const e = queue()[0];
        if (e.method === 'PATCH' && map[e.body.id]) e.body.id = map[e.body.id];
        const headers = { 'Content-Type': 'application/json' }; if (typeof TOKEN !== 'undefined' && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
        let r; try { r = await fetch(e.path, { method: e.method, headers, body: JSON.stringify(e.body) }); } catch { setOffline(true); break; }
        if (r.headers.get('X-Cortex-Offline')) { setOffline(true); break; }
        const j = await r.json().catch(() => ({}));
        if (r.ok) { if (e.tempId && j.id) map[e.tempId] = j.id; }
        else if (r.status === 409) pr.push({ why: j.error || 'Changed elsewhere', at: e.ts, change: e.body });
        else pr.push({ why: `${j.error || 'Refused'} (${e.body.title || e.body.id || 'change'})`, at: e.ts, change: e.body });
        const rest = queue().slice(1); store(KEY, rest);
      }
    } finally { syncing = false; store(DONE, pr.slice(-20)); banner(); if (!queue().length && typeof refresh === 'function') refresh(); }
    if (!queue().length && !problems().length) toast('Back online: offline changes sent');
  }

  // the service worker says whether an answer came from the saved copy or from Cortex
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && typeof e.data.cortexOffline === 'boolean') setOffline(e.data.cortexOffline); });
  window.addEventListener('online', () => { orig('/api/state').then(() => {}).catch(() => {}); });
  window.addEventListener('offline', () => setOffline(true));
  setInterval(() => { if (offline || queue().length) orig('/api/state').catch(() => setOffline(true)); }, 15000); // the worker reports the result
  if (navigator.onLine === false) setOffline(true);
  banner(); setTimeout(sync, 1500);
  window.cortexOffline = { queue, problems, sync, isOffline: () => offline };
})();
