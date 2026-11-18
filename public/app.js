'use strict';
/* Cortex dashboard — vanilla JS single page app. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('cortex.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('cortex.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const TOKEN = (() => {
  const t = new URLSearchParams(location.search).get('token');
  if (t) store.set('token', t);
  return store.get('token', '');
})();

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const r = await fetch(path, { ...opts, headers, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const STATUSES = [['todo', 'To do', 'var(--text-3)'], ['doing', 'In progress', 'var(--info)'], ['blocked', 'Blocked', 'var(--bad)'], ['done', 'Done', 'var(--ok)']];
const STATUS_LABEL = Object.fromEntries(STATUSES.map(([k, l]) => [k, l]));
const STATUS_COLOR = Object.fromEntries(STATUSES.map(([k, , c]) => [k, c]));
const PRIOS = ['urgent', 'high', 'medium', 'low'];
const TYPES = ['memory', 'note', 'decision', 'plan', 'log', 'reference', 'idea'];
const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'];
const PALETTE = ['#8b7cf6', '#4f9cf9', '#3fc5d6', '#3ecf8e', '#f5b84b', '#f2676b', '#ec6fcf', '#a3e635'];
const NAV = [
  ['home', 'Home', 'i-home'], ['live', 'Live', 'i-live'], ['projects', 'Projects', 'i-projects'], ['board', 'Board', 'i-board'],
  ['memory', 'Memory', 'i-memory'], ['graph', 'Graph', 'i-graph'], ['agents', 'Agents', 'i-agents'], ['settings', 'Settings', 'i-settings'],
];

const S = { projects: [], tasks: [], notes: [], activity: [], stats: {}, vault: '', config: null, online: true, route: ['home'], seenActivity: null };
const main = $('#main');

// ---------- helpers ----------
const icon = (id) => `<svg><use href="#${id}"/></svg>`;
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}
const proj = (slug) => S.projects.find((p) => p.slug === slug);
const projColor = (slug) => (proj(slug) && proj(slug).color) || 'var(--text-3)';
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const avatar = (name) => `<div class="av" style="background:hsl(${hue(name)} 55% 50%)">${esc(String(name || '?').trim().slice(0, 2).toUpperCase())}</div>`;
const projectOptions = (sel, none = 'No project') => `<option value="">${none}</option>` + S.projects.map((p) => `<option value="${esc(p.slug)}" ${p.slug === sel ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
const opts = (list, sel, labels = {}) => list.map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(labels[v] || v[0].toUpperCase() + v.slice(1))}</option>`).join('');
const tagChips = (tags) => (tags || []).map((t) => `<span class="chip tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 5000 : 2600);
}
const fail = (e) => toast(e.message || String(e), true);
function copy(text) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast('Copied to clipboard'))
    .catch(() => { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('Copied to clipboard'); });
}
function resolveRef(ref) {
  const r = String(ref).trim().toLowerCase();
  const all = [...S.notes, ...S.tasks, ...S.projects];
  return all.find((x) => x.id.toLowerCase() === r) || all.find((x) => x.slug.toLowerCase() === r) || all.find((x) => x.title.toLowerCase() === r) || null;
}
function openItem(id) {
  const it = [...S.notes, ...S.tasks, ...S.projects].find((x) => x.id === id) || resolveRef(id);
  if (!it) return toast('Not found: ' + id, true);
  if (it.kind === 'task') return openTask(it.id);
  if (it.kind === 'project') return go('projects/' + it.slug);
  go('memory/' + encodeURIComponent(it.id));
}

// ---------- markdown ----------
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, a) => {
    const hit = resolveRef(t.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
    return `<a class="wikilink${hit ? '' : ' broken'}" data-ref="${t.trim()}" title="${hit ? esc(hit.id) : 'Not created yet'}">${a || t}</a>`;
  });
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/^(https?:|mailto:|#)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>').replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|\s|>)#([a-zA-Z][\w\-/]*)/g, '$1<span class="tag" data-tag="$2">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function md(src) {
  const lines = esc(src || '').split('\n');
  const out = [];
  let i = 0;
  const LIST = /^\s*([-*+]|\d+\.)\s+/;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^\s*```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${buf.join('\n')}</code></pre>`); continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^&gt;/.test(l)) {
      const buf = [];
      while (i < lines.length && /^&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${inline(buf.join('<br>'))}</blockquote>`); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().slice(1, -1).split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [h, ...rest] = body;
      out.push(`<table><thead><tr>${cells(h).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) {
        const indent = lines[i].match(/^\s*/)[0].length;
        let t = lines[i].replace(LIST, '');
        const c = t.match(/^\[( |x|X)\]\s+(.*)$/);
        let cb = '';
        if (c) { cb = `<input type="checkbox" disabled ${c[1] !== ' ' ? 'checked' : ''}> `; t = c[2]; }
        items.push(`<li${c ? ' class="task-item"' : ''} style="margin-left:${indent * 7}px">${cb}${inline(t)}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|&gt;|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join('<br>'))}</p>`);
  }
  return out.join('\n');
}

// ---------- routing ----------
function go(hash) { location.hash = '#/' + hash; }
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  S.route = [NAV.some((n) => n[0] === view) ? view : 'home', decodeURIComponent(rest.join('/'))];
}
window.addEventListener('hashchange', () => { if (!confirmLeave()) return; parseRoute(); render(); });

function renderNav() {
  const counts = { board: S.stats.openTasks, memory: S.stats.notes, projects: S.stats.projects, live: S.liveCount };
  $('#nav').innerHTML = NAV.map(([k, label, ic]) => `<button class="dock-btn ${S.route[0] === k ? 'active' : ''}" data-go="${k}">${icon(ic)}<span>${label}</span>${counts[k] ? `<span class="count">${counts[k]}</span>` : ''}</button>`).join('');
  const label = NAV.find((n) => n[0] === S.route[0])[1];
  let sub = '';
  if (S.route[0] === 'projects' && S.route[1]) sub = proj(S.route[1])?.title || S.route[1];
  if (S.route[0] === 'memory' && S.route[1]) sub = S.notes.find((n) => n.id === S.route[1])?.title || '';
  $('#crumbs').innerHTML = sub ? `${label} / <b>${esc(sub)}</b>` : `<b>${label}</b>`;
  $('#status').innerHTML = (S.update && S.local ? `<a class="chip" href="#/settings" style="color:var(--accent)">⬆ Update ${esc(S.update.latest)}</a>` : '')
    + `<span class="dot ${S.online ? '' : 'off'}"></span><span>${S.online ? (S.local ? 'MCP online' : 'Connected') : 'Offline'}</span>`;
}

function render() {
  renderNav();
  const v = S.route[0];
  main.classList.toggle('flush', v === 'memory' || v === 'graph');
  if (v !== 'graph') stopGraph();
  if (v !== 'live') stopScreen();
  ({ live: renderLive, home: renderHome, projects: renderProjects, board: renderBoard, memory: renderMemory, graph: renderGraph, agents: renderAgents, settings: renderSettings }[v])();
}

// ---------- data ----------
let refreshTimer = null;
async function refresh() {
  try {
    const d = await api('/api/state');
    Object.assign(S, d);
    S.online = true;
  } catch (e) { S.online = false; renderNav(); return; }
  if (S.route[0] === 'memory') { renderNav(); updateMemory(); }
  else if (['graph', 'settings', 'live'].includes(S.route[0])) { renderNav(); }
  else render();
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }
function connectEvents() {
  const es = new EventSource('/api/events' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'hello') return;
    if (ev.type === 'restarting') return showRestarting();
    if (ev.type === 'screen-viewed') { if (S.local) toast(`📱 Your screen is being viewed from another device (${ev.ip || 'phone'})`); return; }
    if (ev.type === 'live') return updateLive();
    if (ev.type === 'update') { if (S.route[0] === 'settings') renderSettings(); return scheduleRefresh(); }
    scheduleRefresh();
  };
  es.onopen = () => { if (!S.online) { S.online = true; scheduleRefresh(); } };
  es.onerror = () => { S.online = false; renderNav(); };
}

// ---------- HOME ----------
function feedHtml(list, limit = 40) {
  if (!list.length) return '<div class="empty">No activity yet. Connect an agent from the Agents tab.</div>';
  const seen = S.seenActivity;
  return list.slice(0, limit).map((a) => `
    <div class="ev ${seen && a.ts > seen ? 'new' : ''}" ${a.ref ? `data-open="${esc(a.ref)}" style="cursor:pointer"` : ''}>
      ${avatar(a.agent)}
      <div><div class="row" style="gap:8px"><span class="who">${esc(a.agent)}</span><span class="chip">${esc(a.action)}</span><span class="when" style="margin-left:auto">${timeAgo(a.ts)}</span></div>
      <div class="what">${esc(a.summary)}</div></div>
    </div>`).join('');
}
function taskLine(t) {
  return `<div class="li" data-task="${esc(t.id)}"><span class="pdot" style="background:${STATUS_COLOR[t.status]}"></span><span class="t">${esc(t.title)}</span>
    ${t.project ? `<span class="chip"><span class="pdot" style="background:${projColor(t.project)}"></span>${esc(proj(t.project)?.title || t.project)}</span>` : ''}
    <span class="pr pr-${t.priority}">${esc(t.priority || '')}</span></div>`;
}
function renderHome() {
  const h = new Date().getHours();
  const greet = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const active = S.tasks.filter((t) => t.status === 'doing' || t.status === 'blocked');
  const upNext = S.tasks.filter((t) => t.status === 'todo').slice(0, 6);
  const st = S.stats;
  main.innerHTML = `
    <div class="hero"><h1>${greet}.</h1><p>${st.openTasks || 0} open tasks across ${st.projects || 0} active projects · ${st.agents || 0} agents have used your memory.</p></div>
    <div class="tiles">
      <div class="tile" data-go="projects"><div class="k">Active projects</div><div class="v">${st.projects || 0}</div><div class="s">${S.projects.length} total</div></div>
      <div class="tile" data-go="board"><div class="k">Open tasks</div><div class="v">${st.openTasks || 0}</div><div class="s">${st.doneTasks || 0} completed</div></div>
      <div class="tile" data-go="memory"><div class="k">Memories</div><div class="v">${st.notes || 0}</div><div class="s">Markdown notes in vault</div></div>
      <div class="tile" data-go="agents"><div class="k">Agent actions · 24h</div><div class="v">${st.actions24h || 0}</div><div class="s">${st.agents || 0} agents seen</div></div>
    </div>
    <div class="home-grid">
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="panel"><h3>In progress <button class="btn sm ghost" data-go="board">Open board →</button></h3>
          <div class="list">${active.length ? active.map(taskLine).join('') : '<div class="empty">Nothing in progress.</div>'}</div>
          ${upNext.length ? `<h3 style="margin-top:16px">Up next</h3><div class="list">${upNext.map(taskLine).join('')}</div>` : ''}
        </div>
        <div class="panel"><h3>Projects <button class="btn sm ghost" data-act="new-project">${icon('i-plus')} New</button></h3>
          ${S.projects.filter((p) => p.status === 'active').map((p) => `
            <div class="proj-row" data-go="projects/${esc(p.slug)}"><div class="top"><span class="pdot" style="background:${p.color || 'var(--accent)'}"></span><b>${esc(p.title)}</b><span class="muted small">${p.progress.done}/${p.progress.total} · ${p.progress.progress}%</span></div>
            <div class="bar"><i style="width:${p.progress.progress}%;${p.color ? `background:${p.color}` : ''}"></i></div></div>`).join('') || '<div class="empty">No active projects.</div>'}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="panel"><h3>Live agent activity <button class="btn sm ghost" data-go="agents">All →</button></h3><div class="feed">${feedHtml(S.activity, 25)}</div></div>
        <div class="panel"><h3>Recent memories <button class="btn sm ghost" data-act="new-note">${icon('i-plus')} New</button></h3>
          <div class="list">${S.notes.slice(0, 7).map((n) => `<div class="li" data-go="memory/${encodeURIComponent(n.id)}">${n.pinned ? `<span style="color:var(--accent)">${icon('i-pin')}</span>` : `<span class="muted">${icon('i-memory')}</span>`}<span class="t">${esc(n.title)}</span><span class="chip">${esc(n.type || 'note')}</span><span class="meta">${timeAgo(n.updated)}</span></div>`).join('') || '<div class="empty">No memories yet.</div>'}</div>
        </div>
      </div>
    </div>`;
  S.seenActivity = S.activity[0]?.ts || S.seenActivity;
}

// ---------- PROJECTS ----------
function renderProjects() {
  if (S.route[1]) return renderProject(S.route[1]);
  const show = store.get('projFilter', 'open');
  const list = S.projects.filter((p) => show === 'all' || ['active', 'paused'].includes(p.status));
  main.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p>${S.projects.length} projects in your vault</p></div>
      <div class="actions"><div class="seg"><button data-pf="open" class="${show === 'open' ? 'on' : ''}">Open</button><button data-pf="all" class="${show === 'all' ? 'on' : ''}">All</button></div>
      <button class="btn primary" data-act="new-project">${icon('i-plus')} New project</button></div></div>
    <div class="cards">
      ${list.map((p) => `
        <div class="pcard" style="--pc:${p.color || 'var(--accent)'}" data-go="projects/${esc(p.slug)}">
          <div class="row"><h4 style="flex:1">${esc(p.title)}</h4><span class="chip">${esc(p.status)}</span></div>
          <p>${esc(p.description || 'No description')}</p>
          <div class="bar"><i style="width:${p.progress.progress}%;background:${p.color || ''}"></i></div>
          <div class="nums"><span>${p.progress.progress}% done</span><span>${p.progress.doing} doing</span><span>${p.progress.todo + p.progress.blocked} open</span><span>${p.progress.notes} notes</span></div>
        </div>`).join('')}
      <div class="pcard new-card" data-act="new-project">${icon('i-plus')}<span>New project</span></div>
    </div>`;
  $$('[data-pf]').forEach((b) => (b.onclick = () => { store.set('projFilter', b.dataset.pf); renderProjects(); }));
}
function renderProject(slug) {
  const p = proj(slug);
  if (!p) { main.innerHTML = `<div class="empty">Project not found. <a href="#/projects">Back to projects</a></div>`; return; }
  const tasks = S.tasks.filter((t) => t.project === slug);
  const notes = S.notes.filter((n) => n.project === slug);
  const acts = S.activity.filter((a) => a.project === slug);
  main.innerHTML = `
    <div class="proj-head"><div class="sw" style="background:${p.color || 'var(--accent)'}"></div>
      <div style="flex:1;min-width:240px"><h1>${esc(p.title)}</h1><p>${esc(p.description || '')}</p></div>
      <div class="row"><select class="input" id="p-status" style="width:auto">${opts(PROJECT_STATUSES, p.status)}</select>
      <button class="btn" data-act="edit-project" data-id="${esc(p.id)}">Edit</button>
      <button class="btn" onclick="location.hash='#/board'; store.set('boardProject','${esc(slug)}')">${icon('i-board')} Board</button></div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Progress</div><div class="v">${p.progress.progress}%</div><div class="bar" style="margin-top:6px"><i style="width:${p.progress.progress}%;background:${p.color || ''}"></i></div></div>
      <div class="tile"><div class="k">In progress</div><div class="v">${p.progress.doing}</div><div class="s">${p.progress.blocked} blocked</div></div>
      <div class="tile"><div class="k">To do</div><div class="v">${p.progress.todo}</div><div class="s">${p.progress.done} done</div></div>
      <div class="tile"><div class="k">Notes</div><div class="v">${notes.length}</div><div class="s">linked memories</div></div>
    </div>
    <div class="proj-grid">
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="panel"><h3>Tasks</h3>
          <form class="quick-add" id="p-add" style="margin-bottom:10px"><input class="input" placeholder="Add a task and press Enter…" name="t"><button class="btn">${icon('i-plus')}</button></form>
          ${STATUSES.map(([k, l]) => { const ts = tasks.filter((t) => t.status === k); return ts.length ? `<div class="pal-sec">${l} · ${ts.length}</div><div class="list">${ts.map(taskLine).join('')}</div>` : ''; }).join('') || '<div class="empty">No tasks yet.</div>'}
        </div>
        ${p.body ? `<div class="panel"><h3>Overview</h3><div class="prose" style="padding:0">${md(p.body)}</div></div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="panel"><h3>Memories <button class="btn sm ghost" data-act="new-note" data-project="${esc(slug)}">${icon('i-plus')} New</button></h3>
          <div class="list">${notes.map((n) => `<div class="li" data-go="memory/${encodeURIComponent(n.id)}"><span class="muted">${icon('i-memory')}</span><span class="t">${esc(n.title)}</span><span class="meta">${timeAgo(n.updated)}</span></div>`).join('') || '<div class="empty">No notes for this project.</div>'}</div></div>
        <div class="panel"><h3>Activity</h3><div class="feed">${feedHtml(acts, 20)}</div></div>
      </div>
    </div>`;
  $('#p-status').onchange = (e) => api('/api/items', { method: 'PATCH', body: { id: p.id, status: e.target.value } }).then(refresh).catch(fail);
  $('#p-add').onsubmit = (e) => {
    e.preventDefault();
    const t = e.target.t.value.trim();
    if (t) api('/api/items', { method: 'POST', body: { kind: 'task', title: t, project: slug } }).then(refresh).catch(fail);
  };
}
function projectModal(id) {
  const p = id ? S.projects.find((x) => x.id === id) : null;
  let color = p?.color || PALETTE[S.projects.length % PALETTE.length];
  modal(`
    <div class="modal-head"><h2>${p ? 'Edit project' : 'New project'}</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div>
    <div class="modal-body">
      <input class="input title-in" id="m-title" placeholder="Project name" value="${esc(p?.title || '')}">
      <input class="input" id="m-desc" placeholder="One-line description" value="${esc(p?.description || '')}">
      <div class="field"><label>Color</label><div class="row" id="m-colors">${PALETTE.map((c) => `<button type="button" data-c="${c}" style="width:26px;height:26px;border-radius:8px;border:2px solid ${c === color ? 'var(--text)' : 'transparent'};background:${c};cursor:pointer"></button>`).join('')}</div></div>
      <div class="field"><label>Overview (Markdown)</label><textarea class="input" id="m-body" rows="7" placeholder="Goals, context, links to notes with [[wikilinks]]…">${esc(p?.body || '')}</textarea></div>
    </div>
    <div class="modal-foot">${p ? `<button class="btn danger" id="m-del">${icon('i-trash')} Delete</button>` : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="m-save">${p ? 'Save' : 'Create project'}</button></div>`,
  (root) => {
    $$('#m-colors button', root).forEach((b) => (b.onclick = () => { color = b.dataset.c; $$('#m-colors button', root).forEach((x) => (x.style.borderColor = x.dataset.c === color ? 'var(--text)' : 'transparent')); }));
    $('#m-title', root).focus();
    $('#m-save', root).onclick = async () => {
      const body = { title: $('#m-title', root).value, description: $('#m-desc', root).value, color, body: $('#m-body', root).value };
      try {
        if (p) await api('/api/items', { method: 'PATCH', body: { id: p.id, ...body } });
        else { const r = await api('/api/items', { method: 'POST', body: { kind: 'project', ...body } }); go('projects/' + r.slug); }
        closeModal(); refresh();
      } catch (e) { fail(e); }
    };
    if (p) $('#m-del', root).onclick = async () => {
      if (!confirm(`Delete project "${p.title}"? Its tasks and notes are kept.`)) return;
      await api('/api/items?id=' + encodeURIComponent(p.id), { method: 'DELETE' }).catch(fail);
      closeModal(); go('projects'); refresh();
    };
  });
}

// ---------- BOARD ----------
function renderBoard() {
  const fp = store.get('boardProject', '');
  const fa = store.get('boardAssignee', '');
  const fq = store.get('boardQuery', '');
  const assignees = [...new Set(S.tasks.map((t) => t.assignee).filter(Boolean))];
  const q = fq.toLowerCase();
  const tasks = S.tasks.filter((t) => (!fp || t.project === fp) && (!fa || t.assignee === fa) && (!q || (t.title + ' ' + (t.body || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(q)));
  main.innerHTML = `
    <div class="page-head"><div><h1>Board</h1><p>Drag cards between columns. Agents update this board through MCP.</p></div>
      <div class="actions"><button class="btn primary" data-act="new-task">${icon('i-plus')} New task</button></div></div>
    <div class="board-bar">
      <select class="input" id="f-proj">${projectOptions(fp, 'All projects')}</select>
      <select class="input" id="f-who"><option value="">Anyone</option>${assignees.map((a) => `<option ${a === fa ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
      <input class="input" id="f-q" placeholder="Filter…" value="${esc(fq)}" style="max-width:240px">
      <span class="muted small">${tasks.length} tasks</span>
    </div>
    <div class="board">
      ${STATUSES.map(([k, l, c]) => {
        const col = tasks.filter((t) => t.status === k);
        return `<div class="col" data-col="${k}">
          <div class="col-head"><span class="pdot" style="background:${c}"></span>${l}<span class="n">${col.length}</span></div>
          ${col.map((t) => `
            <div class="card" draggable="true" data-task="${esc(t.id)}">
              <div class="ct">${esc(t.title)}</div>
              <div class="cm">
                <span class="pr pr-${t.priority}">${esc(t.priority || '')}</span>
                ${t.project && !fp ? `<span class="chip"><span class="pdot" style="background:${projColor(t.project)}"></span>${esc(proj(t.project)?.title || t.project)}</span>` : ''}
                ${t.due ? `<span class="chip" style="${t.due < new Date().toISOString().slice(0, 10) && t.status !== 'done' ? 'color:var(--bad)' : ''}">${esc(t.due)}</span>` : ''}
                ${tagChips(t.tags)}
                ${t.assignee ? `<span class="who">@${esc(t.assignee)}</span>` : ''}
              </div>
            </div>`).join('')}
          <form class="quick-add" data-add="${k}"><input class="input" name="t" placeholder="+ Add task"></form>
        </div>`;
      }).join('')}
    </div>`;
  $('#f-proj').onchange = (e) => { store.set('boardProject', e.target.value); renderBoard(); };
  $('#f-who').onchange = (e) => { store.set('boardAssignee', e.target.value); renderBoard(); };
  $('#f-q').oninput = (e) => { store.set('boardQuery', e.target.value); clearTimeout(renderBoard.t); renderBoard.t = setTimeout(() => { renderBoard(); const i = $('#f-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
  $$('form[data-add]').forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const t = f.t.value.trim();
    if (!t) return;
    api('/api/items', { method: 'POST', body: { kind: 'task', title: t, status: f.dataset.add, project: fp || undefined } }).then(refresh).catch(fail);
  }));
  // drag & drop
  let dragId = null;
  $$('.card').forEach((c) => {
    c.ondragstart = (e) => { dragId = c.dataset.task; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); };
    c.ondragend = () => c.classList.remove('dragging');
  });
  $$('.col').forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); };
    col.ondrop = (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = dragId || e.dataTransfer.getData('text/plain');
      const t = S.tasks.find((x) => x.id === id);
      if (!t || t.status === col.dataset.col) return;
      t.status = col.dataset.col;
      renderBoard();
      api('/api/items', { method: 'PATCH', body: { id, status: col.dataset.col } }).then(refresh).catch((er) => { fail(er); refresh(); });
    };
  });
}
async function openTask(id, defaults = {}) {
  let t = null;
  if (id) { try { t = await api('/api/item?id=' + encodeURIComponent(id)); } catch (e) { return fail(e); } }
  const v = t || { status: 'todo', priority: 'medium', ...defaults };
  modal(`
    <div class="modal-head"><h2>${t ? 'Task' : 'New task'}</h2>${t ? `<span class="muted small">${esc(t.id)}</span>` : ''}<button class="btn ghost sm" data-close>${icon('i-x')}</button></div>
    <div class="modal-body">
      <input class="input title-in" id="t-title" placeholder="What needs to be done?" value="${esc(v.title || '')}">
      <div class="grid2">
        <div class="field"><label>Status</label><select class="input" id="t-status">${opts(STATUSES.map((s) => s[0]), v.status, STATUS_LABEL)}</select></div>
        <div class="field"><label>Priority</label><select class="input" id="t-prio">${opts(PRIOS, v.priority)}</select></div>
        <div class="field"><label>Project</label><select class="input" id="t-proj">${projectOptions(v.project)}</select></div>
        <div class="field"><label>Assignee</label><input class="input" id="t-who" placeholder="you, claude, codex…" value="${esc(v.assignee || '')}"></div>
        <div class="field"><label>Due</label><input class="input" id="t-due" type="date" value="${esc(v.due || '')}"></div>
        <div class="field"><label>Tags</label><input class="input" id="t-tags" placeholder="comma, separated" value="${esc((v.tags || []).join(', '))}"></div>
      </div>
      <div class="field"><label>Details (Markdown) <span class="seg" style="float:right;text-transform:none"><button type="button" class="on" data-tm="edit">Edit</button><button type="button" data-tm="preview">Preview</button></span></label>
        <textarea class="input" id="t-body" rows="9" placeholder="Context, acceptance criteria, [[links]]…" style="font-family:var(--mono);font-size:13px">${esc(v.body || '')}</textarea>
        <div class="prose" id="t-prev" style="display:none;border:1px solid var(--line);border-radius:10px;padding:12px 14px;max-height:300px"></div></div>
      ${t ? `<div class="small muted">Created ${timeAgo(t.created)}${t.created_by ? ' by ' + esc(t.created_by) : ''} · updated ${timeAgo(t.updated)}${t.completed ? ' · completed ' + timeAgo(t.completed) : ''}
        ${t.backlinks?.length ? `<br>Linked from: ${t.backlinks.map((b) => `<a href="javascript:void 0" data-open="${esc(b.id)}">${esc(b.title)}</a>`).join(', ')}` : ''}</div>` : ''}
    </div>
    <div class="modal-foot">${t ? `<button class="btn danger" id="t-del">${icon('i-trash')} Delete</button>` : ''}<span class="spacer"></span><span class="muted small">Ctrl+Enter to save</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="t-save">${t ? 'Save' : 'Create task'}</button></div>`,
  (root) => {
    const title = $('#t-title', root);
    if (!t) title.focus();
    $$('[data-tm]', root).forEach((b) => (b.onclick = () => {
      $$('[data-tm]', root).forEach((x) => x.classList.toggle('on', x === b));
      const prev = b.dataset.tm === 'preview';
      $('#t-body', root).style.display = prev ? 'none' : '';
      $('#t-prev', root).style.display = prev ? '' : 'none';
      if (prev) $('#t-prev', root).innerHTML = md($('#t-body', root).value) || '<span class="muted">Nothing here yet.</span>';
    }));
    const save = async () => {
      const body = {
        title: title.value, status: $('#t-status', root).value, priority: $('#t-prio', root).value, project: $('#t-proj', root).value || null,
        assignee: $('#t-who', root).value.trim() || null, due: $('#t-due', root).value || null, tags: $('#t-tags', root).value, body: $('#t-body', root).value,
      };
      try {
        if (t) await api('/api/items', { method: 'PATCH', body: { id: t.id, ...body } });
        else await api('/api/items', { method: 'POST', body: { kind: 'task', ...body } });
        closeModal(); refresh();
      } catch (e) { fail(e); }
    };
    $('#t-save', root).onclick = save;
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
    if (t) $('#t-del', root).onclick = async () => {
      if (!confirm('Delete this task? (moved to vault trash)')) return;
      await api('/api/items?id=' + encodeURIComponent(t.id), { method: 'DELETE' }).catch(fail);
      closeModal(); refresh();
    };
  });
}

// ---------- MEMORY ----------
const ED = { id: null, item: null, dirty: false, mode: store.get('edMode', 'split'), timer: null, saving: false };
function confirmLeave() {
  if (ED.dirty) { saveNote(); }
  return true;
}
function memFilters() { return store.get('memFilters', { q: '', type: '', project: '', tag: '' }); }
function filteredNotes() {
  const f = memFilters();
  const q = f.q.toLowerCase();
  return S.notes.filter((n) => (!f.type || (n.type || 'note') === f.type) && (!f.project || n.project === f.project) && (!f.tag || (n.allTags || []).includes(f.tag))
    && (!q || (n.title + ' ' + n.excerpt + ' ' + (n.allTags || []).join(' ')).toLowerCase().includes(q)));
}
function renderMemory() {
  const f = memFilters();
  const allTags = [...new Set(S.notes.flatMap((n) => n.allTags || []))].sort();
  main.innerHTML = `
    <div class="mem ${S.route[1] ? 'has-sel' : ''}">
      <div class="mem-side">
        <div class="mem-filters">
          <div class="row"><input class="input" id="mf-q" placeholder="Filter memories…" value="${esc(f.q)}"><button class="btn primary" data-act="new-note" title="New memory">${icon('i-plus')}</button></div>
          <div class="row" style="gap:6px">
            <select class="input" id="mf-type"><option value="">All types</option>${opts(TYPES, f.type)}</select>
            <select class="input" id="mf-proj">${projectOptions(f.project, 'All projects')}</select>
          </div>
          ${allTags.length ? `<select class="input" id="mf-tag"><option value="">All tags</option>${allTags.map((t) => `<option ${t === f.tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="mem-list" id="mem-list"></div>
      </div>
      <div class="mem-main" id="mem-main"></div>
    </div>`;
  const setF = (k, v) => { const ff = memFilters(); ff[k] = v; store.set('memFilters', ff); renderMemList(); };
  $('#mf-q').oninput = (e) => setF('q', e.target.value);
  $('#mf-type').onchange = (e) => setF('type', e.target.value);
  $('#mf-proj').onchange = (e) => setF('project', e.target.value);
  if ($('#mf-tag')) $('#mf-tag').onchange = (e) => setF('tag', e.target.value);
  renderMemList();
  loadEditor(S.route[1]);
}
function renderMemList() {
  const el = $('#mem-list');
  if (!el) return;
  const list = filteredNotes();
  el.innerHTML = list.map((n) => `
    <div class="mi ${n.id === S.route[1] ? 'active' : ''}" data-go="memory/${encodeURIComponent(n.id)}">
      <div class="t">${n.pinned ? `<span style="color:var(--accent)">${icon('i-pin')}</span>` : ''}<span>${esc(n.title)}</span></div>
      ${n.excerpt ? `<div class="x">${esc(n.excerpt)}</div>` : ''}
      <div class="m"><span class="chip">${esc(n.type || 'note')}</span>${n.project ? `<span class="pdot" style="background:${projColor(n.project)}"></span>${esc(proj(n.project)?.title || n.project)}` : ''}<span style="margin-left:auto">${n.agent ? esc(n.agent) + ' · ' : ''}${timeAgo(n.updated)}</span></div>
    </div>`).join('') || '<div class="empty" style="margin:8px">No memories match.</div>';
}
async function loadEditor(id) {
  const el = $('#mem-main');
  if (!id) {
    ED.id = null; ED.item = null;
    el.innerHTML = `<div style="display:grid;place-items:center;height:100%;padding:30px"><div class="empty" style="max-width:420px">
      <div style="font-size:16px;color:var(--text);font-weight:600;margin-bottom:6px">Your shared memory</div>
      Notes here are Markdown files in <code>${esc(S.vault)}</code>. You and your AI agents both read and write them. Link notes with <code>[[Note title]]</code>.<br><br>
      <button class="btn primary" data-act="new-note">${icon('i-plus')} New memory</button></div></div>`;
    return;
  }
  try { ED.item = await api('/api/item?id=' + encodeURIComponent(id)); } catch (e) { el.innerHTML = `<div class="empty" style="margin:30px">${esc(e.message)}</div>`; return; }
  ED.id = id; ED.dirty = false;
  drawEditor();
}
function drawEditor() {
  const n = ED.item;
  const el = $('#mem-main');
  if (!el || !n) return;
  el.innerHTML = `
    <div class="ed-head">
      <div class="row"><button class="btn ghost sm" onclick="go('memory')" title="Back">←</button><input class="ed-title" id="ed-title" value="${esc(n.title)}" placeholder="Title"></div>
      <div class="ed-meta">
        <select class="input" id="ed-type">${opts(TYPES, n.type || 'note')}</select>
        <select class="input" id="ed-proj">${projectOptions(n.project)}</select>
        <input class="input tags-in" id="ed-tags" placeholder="tags, comma separated" value="${esc((n.tags || []).join(', '))}">
        <button class="btn sm ${n.pinned ? 'primary' : ''}" id="ed-pin" title="Pinned notes are always loaded by agents">${icon('i-pin')} ${n.pinned ? 'Pinned' : 'Pin'}</button>
        <div class="seg">${['edit', 'split', 'preview'].map((m) => `<button data-mode="${m}" class="${ED.mode === m ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
        <button class="btn sm ghost danger" id="ed-del" title="Delete">${icon('i-trash')}</button>
      </div>
    </div>
    <div class="ed-body ${ED.mode === 'split' ? 'split' : ''}">
      ${ED.mode !== 'preview' ? `<textarea id="ed-body" spellcheck="true" placeholder="Write in Markdown. Link notes with [[Note title]], tag with #tags.">${esc(n.body || '')}</textarea>` : ''}
      ${ED.mode !== 'edit' ? `<div class="prose" id="ed-prev">${md(n.body)}</div>` : ''}
    </div>
    <div class="ed-foot">
      <div class="links"><b>Links:</b> ${(n.links || []).map((l) => `<span class="chip" style="cursor:pointer" data-open="${esc(l)}">${esc(resolveRef(l)?.title || l)}</span>`).join('') || '<span>none</span>'}
        ${(n.broken || []).map((b) => `<span class="chip" style="cursor:pointer;opacity:.6" data-create="${esc(b)}" title="Click to create">+ ${esc(b)}</span>`).join('')}</div>
      <div class="links"><b>Backlinks:</b> ${(n.backlinks || []).map((b) => `<span class="chip" style="cursor:pointer" data-open="${esc(b.id)}">${esc(b.title)}</span>`).join('') || '<span>none</span>'}</div>
      <span class="save-state" id="ed-state">${n.agent ? `by ${esc(n.agent)} · ` : ''}${esc(n.id)}.md · saved ${timeAgo(n.updated)}</span>
    </div>`;
  const mark = () => { ED.dirty = true; $('#ed-state').textContent = 'Unsaved changes…'; clearTimeout(ED.timer); ED.timer = setTimeout(saveNote, 1200); };
  const body = $('#ed-body');
  if (body) body.oninput = () => { mark(); const p = $('#ed-prev'); if (p) p.innerHTML = md(body.value); };
  $('#ed-title').oninput = mark;
  ['ed-type', 'ed-proj'].forEach((x) => ($('#' + x).onchange = () => { ED.dirty = true; saveNote(); }));
  $('#ed-tags').onchange = () => { ED.dirty = true; saveNote(); };
  $('#ed-pin').onclick = () => { ED.item.pinned = !ED.item.pinned; ED.dirty = true; saveNote().then(drawEditor); };
  $$('[data-mode]').forEach((b) => (b.onclick = () => { collectEditor(); ED.mode = b.dataset.mode; store.set('edMode', ED.mode); drawEditor(); }));
  $('#ed-del').onclick = async () => {
    if (!confirm(`Delete "${n.title}"? (moved to vault trash)`)) return;
    ED.dirty = false;
    await api('/api/items?id=' + encodeURIComponent(n.id), { method: 'DELETE' }).catch(fail);
    go('memory'); refresh();
  };
}
function collectEditor() {
  if (!ED.item || !$('#ed-title')) return;
  ED.item.title = $('#ed-title').value;
  if ($('#ed-body')) ED.item.body = $('#ed-body').value;
  ED.item.type = $('#ed-type').value;
  ED.item.project = $('#ed-proj').value;
  ED.item.tags = $('#ed-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
}
async function saveNote() {
  if (!ED.dirty || !ED.item) return;
  clearTimeout(ED.timer);
  collectEditor();
  const n = ED.item;
  ED.dirty = false;
  try {
    await api('/api/items', { method: 'PATCH', body: { id: n.id, title: n.title, body: n.body, type: n.type, project: n.project || null, tags: n.tags, pinned: n.pinned ? true : null, quiet: true } });
    const st = $('#ed-state');
    if (st) st.textContent = 'Saved ✓';
    const fresh = await api('/api/item?id=' + encodeURIComponent(n.id));
    if (ED.id === n.id && !ED.dirty) {
      ED.item = { ...fresh, body: $('#ed-body') ? $('#ed-body').value : fresh.body };
      const links = $('.ed-foot .links');
      if (links) { const hadFocus = document.activeElement; drawFootOnly(); if (hadFocus && hadFocus.id) { /* focus kept since we only touched footer */ } }
    }
  } catch (e) { ED.dirty = true; fail(e); }
}
function drawFootOnly() {
  const n = ED.item;
  const foot = $('.ed-foot');
  if (!foot) return;
  foot.children[0].innerHTML = `<b>Links:</b> ${(n.links || []).map((l) => `<span class="chip" style="cursor:pointer" data-open="${esc(l)}">${esc(resolveRef(l)?.title || l)}</span>`).join('') || '<span>none</span>'}
    ${(n.broken || []).map((b) => `<span class="chip" style="cursor:pointer;opacity:.6" data-create="${esc(b)}" title="Click to create">+ ${esc(b)}</span>`).join('')}`;
  foot.children[1].innerHTML = `<b>Backlinks:</b> ${(n.backlinks || []).map((b) => `<span class="chip" style="cursor:pointer" data-open="${esc(b.id)}">${esc(b.title)}</span>`).join('') || '<span>none</span>'}`;
  $('#ed-state').textContent = `Saved ✓ · ${n.id}.md`;
}
async function updateMemory() {
  renderMemList();
  if (!ED.id || ED.dirty) return;
  const meta = S.notes.find((x) => x.id === ED.id);
  if (!meta) { ED.id = null; ED.item = null; go('memory'); return; }
  if (ED.item && meta.updated !== ED.item.updated && document.activeElement?.id !== 'ed-body' && document.activeElement?.id !== 'ed-title') {
    ED.item = await api('/api/item?id=' + encodeURIComponent(ED.id)).catch(() => ED.item);
    drawEditor();
  }
}
async function newNote(defaults = {}) {
  const title = defaults.title || prompt('Title for the new memory:');
  if (!title) return;
  try {
    const r = await api('/api/items', { method: 'POST', body: { kind: 'note', title, type: 'note', body: `# ${title}\n\n`, ...defaults } });
    await refresh();
    go('memory/' + encodeURIComponent(r.id));
  } catch (e) { fail(e); }
}

// ---------- GRAPH ----------
let G = null;
function stopGraph() { if (G) { cancelAnimationFrame(G.raf); window.removeEventListener('resize', G.resize); G = null; } }
async function renderGraph() {
  stopGraph();
  const showTasks = store.get('gTasks', true);
  main.innerHTML = `<div class="graph-wrap"><canvas id="gc"></canvas>
    <div class="graph-legend">
      <b style="margin-bottom:2px">Knowledge graph</b>
      <label><span class="pdot" style="background:var(--accent);width:12px;height:12px"></span> Projects</label>
      <label><span class="pdot" style="background:var(--accent-2)"></span> Notes / memories</label>
      <label><input type="checkbox" id="g-tasks" ${showTasks ? 'checked' : ''}> <span class="pdot" style="background:var(--warn)"></span> Tasks</label>
      <span class="muted small">Scroll to zoom · drag to pan · click to open</span>
    </div><div class="graph-tip" id="g-tip"></div></div>`;
  $('#g-tasks').onchange = (e) => { store.set('gTasks', e.target.checked); renderGraph(); };
  const data = await api('/api/graph');
  if (S.route[0] !== 'graph') return;
  const canvas = $('#gc');
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const C = (v) => css.getPropertyValue(v).trim();
  const nodes = data.nodes.filter((n) => showTasks || n.kind !== 'task').map((n) => ({ ...n, x: (Math.random() - 0.5) * 600, y: (Math.random() - 0.5) * 600, vx: 0, vy: 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e, s: byId.get(e.source), t: byId.get(e.target) }));
  const deg = new Map();
  edges.forEach((e) => { deg.set(e.s, (deg.get(e.s) || 0) + 1); deg.set(e.t, (deg.get(e.t) || 0) + 1); });
  const radius = (n) => (n.kind === 'project' ? 11 : n.kind === 'task' ? 4.5 : 6) + Math.min(6, (deg.get(n) || 0) * 0.6);
  const color = (n) => (n.kind === 'project' ? n.color || C('--accent') : n.kind === 'task' ? (n.status === 'done' ? C('--ok') : C('--warn')) : C('--accent-2'));
  G = { raf: 0, alpha: 1, view: { x: 0, y: 0, k: 1 }, hover: null, drag: null, pan: null };
  const dpr = window.devicePixelRatio || 1;
  G.resize = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; G.w = r.width; G.h = r.height; G.alpha = Math.max(G.alpha, 0.1); };
  G.resize();
  window.addEventListener('resize', G.resize);
  const toWorld = (px, py) => ({ x: (px - G.w / 2 - G.view.x) / G.view.k, y: (py - G.h / 2 - G.view.y) / G.view.k });
  const pick = (px, py) => { const p = toWorld(px, py); let best = null; let bd = Infinity; for (const n of nodes) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < radius(n) + 5 / G.view.k && d < bd) { bd = d; best = n; } } return best; };
  const neighbors = (n) => { const s = new Set([n]); edges.forEach((e) => { if (e.s === n) s.add(e.t); if (e.t === n) s.add(e.s); }); return s; };
  function step() {
    if (G.alpha > 0.005) {
      const a = G.alpha;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          let dx = n.x - m.x; let dy = n.y - m.y;
          let d2 = dx * dx + dy * dy || 0.01;
          if (d2 > 160000) continue;
          const f = (900 / d2) * a;
          dx *= f; dy *= f;
          n.vx += dx; n.vy += dy; m.vx -= dx; m.vy -= dy;
        }
        n.vx -= n.x * 0.004 * a; n.vy -= n.y * 0.004 * a;
      }
      for (const e of edges) {
        const dx = e.t.x - e.s.x; const dy = e.t.y - e.s.y;
        const d = Math.hypot(dx, dy) || 1;
        const target = e.type === 'project' ? 70 : 95;
        const f = ((d - target) / d) * 0.05 * a;
        e.s.vx += dx * f; e.s.vy += dy * f; e.t.vx -= dx * f; e.t.vy -= dy * f;
      }
      for (const n of nodes) { if (n === G.drag) continue; n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy; }
      G.alpha *= 0.985;
    }
    draw();
    G.raf = requestAnimationFrame(step);
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, G.w, G.h);
    ctx.translate(G.w / 2 + G.view.x, G.h / 2 + G.view.y);
    ctx.scale(G.view.k, G.view.k);
    const hl = G.hover ? neighbors(G.hover) : null;
    ctx.lineWidth = 1 / G.view.k;
    for (const e of edges) {
      ctx.strokeStyle = hl && (hl.has(e.s) && hl.has(e.t)) ? C('--accent') : C('--line-2');
      ctx.globalAlpha = hl && !(hl.has(e.s) && hl.has(e.t)) ? 0.25 : e.type === 'project' ? 0.5 : 0.9;
      ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); ctx.stroke();
    }
    for (const n of nodes) {
      ctx.globalAlpha = hl && !hl.has(n) ? 0.25 : 1;
      ctx.fillStyle = color(n);
      ctx.beginPath();
      const r = radius(n);
      if (n.kind === 'task') ctx.rect(n.x - r, n.y - r, r * 2, r * 2); else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (n === G.hover) { ctx.strokeStyle = C('--text'); ctx.lineWidth = 2 / G.view.k; ctx.stroke(); ctx.lineWidth = 1 / G.view.k; }
      if (n.kind !== 'task' && (G.view.k > 0.7 || n.kind === 'project') && (!hl || hl.has(n))) {
        ctx.fillStyle = C('--text-2');
        ctx.font = `${(n.kind === 'project' ? 12.5 : 11) / Math.max(0.8, G.view.k)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(n.title.length > 30 ? n.title.slice(0, 29) + '…' : n.title, n.x, n.y + r + 13 / Math.max(0.8, G.view.k));
      }
    }
    ctx.globalAlpha = 1;
  }
  const tip = $('#g-tip');
  let down = null;
  canvas.onmousedown = (e) => {
    const r = canvas.getBoundingClientRect();
    const n = pick(e.clientX - r.left, e.clientY - r.top);
    down = { x: e.clientX, y: e.clientY, n, vx: G.view.x, vy: G.view.y, moved: false };
    if (n) { G.drag = n; G.alpha = Math.max(G.alpha, 0.3); }
  };
  window.addEventListener('mouseup', function up(e) {
    if (!G) return window.removeEventListener('mouseup', up);
    if (down && !down.moved && down.n) openItem(down.n.id);
    down = null; G.drag = null;
  });
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left; const py = e.clientY - r.top;
    if (down) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) down.moved = true;
      if (G.drag) { const p = toWorld(px, py); G.drag.x = p.x; G.drag.y = p.y; G.drag.vx = G.drag.vy = 0; G.alpha = Math.max(G.alpha, 0.2); }
      else { G.view.x = down.vx + (e.clientX - down.x); G.view.y = down.vy + (e.clientY - down.y); }
      return;
    }
    G.hover = pick(px, py);
    canvas.style.cursor = G.hover ? 'pointer' : 'grab';
    if (G.hover) { tip.style.display = 'block'; tip.style.left = px + 14 + 'px'; tip.style.top = py + 10 + 'px'; tip.innerHTML = `<b>${esc(G.hover.title)}</b><br><span class="muted">${esc(G.hover.kind)}${G.hover.status ? ' · ' + esc(G.hover.status) : ''}</span>`; }
    else tip.style.display = 'none';
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left - G.w / 2; const py = e.clientY - r.top - G.h / 2;
    const k = Math.min(4, Math.max(0.2, G.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    G.view.x = px - ((px - G.view.x) * k) / G.view.k; G.view.y = py - ((py - G.view.y) * k) / G.view.k; G.view.k = k;
  };
  for (let i = 0; i < 120; i++) { /* warm-up */ G.alpha = 1 - i / 160; }
  G.alpha = 1;
  step();
}

// ---------- AGENTS ----------
async function renderAgents() {
  if (!S.config) { try { S.config = await api('/api/config'); } catch (e) { return fail(e); } }
  const cfg = S.config;
  const agents = {};
  for (const a of S.activity) { const x = (agents[a.agent] = agents[a.agent] || { name: a.agent, count: 0, last: a.ts }); x.count++; if (a.ts > x.last) x.last = a.ts; }
  const list = Object.values(agents).sort((a, b) => (a.last < b.last ? 1 : -1));
  const sel = store.get('agentSel', '');
  const acts = sel ? S.activity.filter((a) => a.agent === sel) : S.activity;
  const TOOLS = ['cortex_start', 'project_list', 'project_create', 'project_update', 'task_list', 'task_get', 'task_create', 'task_update', 'memory_write', 'memory_get', 'memory_update', 'memory_search', 'memory_list', 'memory_links', 'memory_delete', 'activity_log', 'activity_list'];
  main.innerHTML = `
    <div class="page-head"><div><h1>Agents</h1><p>Connect any MCP-capable AI to Cortex. It becomes the agents' shared memory and task board.</p></div></div>
    <div class="agents-grid">
      <div class="panel"><h3>Connect an agent</h3>
        <p class="small muted" style="margin-top:-4px">MCP endpoint: <code>${esc(cfg.url)}</code> · Vault: <code>${esc(cfg.vault)}</code></p>
        ${cfg.items.map((it, i) => `
          <details class="conn" ${i === 0 ? 'open' : ''}><summary>${esc(it.name)}<span class="muted">${esc(it.where)}</span></summary>
            <div class="body">
              <div class="code"><pre>${esc(it.code)}</pre><button class="btn sm copy" data-copy="${i}:code">${icon('i-copy')}</button></div>
              ${it.alt ? `<div class="small muted">${esc(it.altLabel)}</div><div class="code"><pre>${esc(it.alt)}</pre><button class="btn sm copy" data-copy="${i}:alt">${icon('i-copy')}</button></div>` : ''}
            </div></details>`).join('')}
        <h3 style="margin-top:18px">Tools agents get</h3>
        <div class="tools-list">${TOOLS.map((t) => `<code>${t}</code>`).join('')}</div>
        <p class="small muted">Tip: add “Use the Cortex MCP server as your memory. Call cortex_start at the beginning of each task.” to your agent's system prompt or CLAUDE.md.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div class="panel"><h3>Agents seen</h3>
          <div class="agent-row ${!sel ? 'on' : ''}" data-agent=""><div class="av" style="background:var(--line-2)">∗</div><div><b>Everyone</b></div><span class="muted small">${S.activity.length}</span></div>
          ${list.map((a) => `<div class="agent-row ${sel === a.name ? 'on' : ''}" data-agent="${esc(a.name)}">${avatar(a.name)}<div><b>${esc(a.name)}</b><div class="small muted">last active ${timeAgo(a.last)}</div></div><span class="muted small">${a.count}</span></div>`).join('')}
        </div>
        <div class="panel"><h3>Activity log${sel ? ' · ' + esc(sel) : ''}</h3><div class="feed" style="max-height:560px">${feedHtml(acts, 120)}</div></div>
      </div>
    </div>`;
  $$('[data-copy]').forEach((b) => (b.onclick = () => { const [i, k] = b.dataset.copy.split(':'); copy(cfg.items[i][k]); }));
  $$('[data-agent]').forEach((r) => (r.onclick = () => { store.set('agentSel', r.dataset.agent); renderAgents(); }));
}

// ---------- LIVE ----------
const LIVE = { sessions: [], screenEnabled: false, drafts: {}, open: {}, screenOn: store.get('screenOn', true), timer: null, lastUrl: null, rendered: null };
const STATUS_TEXT = { working: 'Working', waiting: 'Waiting for you', 'needs-you': 'Needs you', done: 'Done', error: 'Error' };
async function fetchLive() {
  const d = await api('/api/live');
  LIVE.sessions = d.sessions;
  LIVE.screenEnabled = d.screenEnabled;
  S.liveCount = d.sessions.filter((x) => ['working', 'needs-you'].includes(x.status)).length;
}
let liveTimer = null;
function updateLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    try { await fetchLive(); } catch { return; }
    renderNav();
    if (S.route[0] !== 'live') return;
    if (LIVE.rendered !== LIVE.screenEnabled) renderLive(true); else renderSessions();
  }, 250);
}
async function renderLive(skipFetch) {
  if (!skipFetch) { try { await fetchLive(); } catch (e) { return fail(e); } renderNav(); }
  if (S.route[0] !== 'live') return;
  LIVE.rendered = LIVE.screenEnabled;
  main.innerHTML = `
    <div class="page-head"><div><h1>Live</h1><p>Watch your computer and your agents work, and message them, from here or your phone.</p></div>
      ${S.local ? `<div class="actions"><button class="btn" data-go="settings">${icon('i-phone')} Connect your phone</button></div>` : ''}</div>
    <div class="panel screen-panel" id="screen-panel">${screenPanelHtml()}</div>
    <div class="live-sessions" id="live-sessions"></div>`;
  const en = $('#scr-enable');
  if (en) en.onclick = () => api('/api/settings', { method: 'POST', body: { screen: { enabled: true } } }).then(() => renderLive()).catch(fail);
  const tg = $('#scr-toggle');
  if (tg) tg.onclick = () => { LIVE.screenOn = !LIVE.screenOn; store.set('screenOn', LIVE.screenOn); tg.textContent = LIVE.screenOn ? 'Pause' : 'Resume'; $('#screen-panel').classList.toggle('paused', !LIVE.screenOn); if (LIVE.screenOn) startScreen(); else stopScreen(); };
  const box = $('#scr-box');
  if (box) {
    $('#scr-full').onclick = () => $('#screen-panel').classList.add('expanded');
    box.onclick = () => { const p = $('#screen-panel'); if (p.classList.contains('expanded')) p.classList.toggle('zoomed'); else p.classList.add('expanded'); };
    $('#scr-close').onclick = (e) => { e.stopPropagation(); $('#screen-panel').classList.remove('expanded', 'zoomed'); };
  }
  renderSessions();
  startScreen();
}
function screenPanelHtml() {
  if (!LIVE.screenEnabled) {
    return `<h3>${icon('i-live')} Your computer's screen</h3>
      <div class="empty">Screen sharing is off.<br>${S.local ? `<button class="btn primary" id="scr-enable" style="margin-top:10px">Turn on screen sharing</button>` : 'Turn it on in Settings on your computer.'}
      <div class="small" style="margin-top:8px">Only this computer and devices you've paired can see it.</div></div>`;
  }
  return `<h3><span class="live-dot"></span> Screen <span class="small muted" id="scr-meta" style="text-transform:none;letter-spacing:0;font-weight:400;white-space:nowrap"></span>
      <span style="margin-left:auto;display:flex;gap:6px"><button class="btn sm" id="scr-toggle">${LIVE.screenOn ? 'Pause' : 'Resume'}</button><button class="btn sm" id="scr-full" title="Full screen">⤢</button></span></h3>
    <div class="screen-box" id="scr-box"><img id="scr-img" alt="Live view of your computer screen"><div class="screen-msg" id="scr-msg">${LIVE.screenOn ? 'Connecting…' : 'Paused'}</div>
      <button class="btn sm scr-close" id="scr-close">${icon('i-x')} Close</button></div>`;
}
function stopScreen() { clearTimeout(LIVE.timer); LIVE.timer = null; }
function startScreen() {
  stopScreen();
  if (!LIVE.screenEnabled || !LIVE.screenOn) return;
  const loop = async () => {
    const img = $('#scr-img');
    if (S.route[0] !== 'live' || !LIVE.screenOn || !img) return;
    if (!document.hidden) {
      const msg = $('#scr-msg');
      try {
        const r = await fetch('/api/screen?t=' + Date.now(), { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        const url = URL.createObjectURL(await r.blob());
        img.onload = () => { if (LIVE.lastUrl && LIVE.lastUrl !== url) URL.revokeObjectURL(LIVE.lastUrl); LIVE.lastUrl = url; };
        img.src = url;
        if (msg) msg.style.display = 'none';
        const meta = $('#scr-meta');
        if (meta) meta.textContent = 'live · ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      } catch (e) {
        if (msg) { msg.style.display = ''; msg.textContent = e.message; }
        LIVE.timer = setTimeout(loop, 4000);
        return;
      }
    }
    LIVE.timer = setTimeout(loop, 1000);
  };
  loop();
}
function sessionCard(x) {
  const ev = (x.events || []).slice().reverse();
  const t = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const snapUrl = x.snapshot ? `/api/live/snap?id=${encodeURIComponent(x.id)}&t=${encodeURIComponent(x.snapshot.ts)}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}` : '';
  return `<div class="lcard s-${esc(x.status)}">
    <div class="lc-head">${avatar(x.agent)}<div class="lc-who"><b>${esc(x.agent)}</b><span class="small muted">${x.workspace ? esc(x.workspace) + ' · ' : ''}${timeAgo(x.updated)}</span></div>
      <span class="spill ${esc(x.status)}">${esc(STATUS_TEXT[x.status] || x.status)}</span><button class="btn ghost sm" data-live-del="${esc(x.id)}" title="Dismiss">${icon('i-x')}</button></div>
    ${x.title ? `<div class="lc-title">${esc(x.title)}</div>` : ''}
    ${x.step ? `<div class="lc-step">${x.status === 'working' ? '<span class="spinner"></span>' : ''}<span>${esc(x.step)}</span></div>` : ''}
    ${typeof x.progress === 'number' ? `<div class="bar"><i style="width:${x.progress}%"></i></div>` : ''}
    ${x.snapshot ? `<img class="lc-snap" src="${snapUrl}" data-snap="${esc(snapUrl)}" alt="Snapshot from ${esc(x.agent)}" loading="lazy">${x.snapshot.caption ? `<div class="small muted">${esc(x.snapshot.caption)}</div>` : ''}` : ''}
    <details class="lc-log" data-log="${esc(x.id)}" ${LIVE.open[x.id] ? 'open' : ''}><summary>Activity · ${ev.length}</summary>
      <div class="lc-events">${ev.slice(0, 40).map((e) => `<div class="lev k-${esc(e.kind)}"><span class="tm">${t(e.ts)}</span><span>${esc(e.text)}</span></div>`).join('') || '<span class="muted small">Nothing yet</span>'}</div></details>
    <form class="lc-msg" data-msg-form="${esc(x.id)}"><input class="input" data-msg="${esc(x.id)}" placeholder="Message ${esc(x.agent)}…" autocomplete="off"><button class="btn primary sm">Send</button></form>
    ${x.unread > 0 ? `<div class="small muted">✉ ${x.unread} message${x.unread > 1 ? 's' : ''} waiting: delivered at the agent's next step</div>` : ''}
  </div>`;
}
function renderSessions() {
  const el = $('#live-sessions');
  if (!el) return;
  const active = document.activeElement;
  const focusId = active && active.dataset ? active.dataset.msg : null;
  const caret = focusId ? active.selectionStart : 0;
  if (!LIVE.sessions.length) {
    el.innerHTML = `<div class="panel" style="grid-column:1/-1"><h3>No agents reporting yet</h3>
      <p>Agents show up here with their current step, screenshots and a message box.</p>
      <ul class="small" style="line-height:1.9">
        <li><b>Claude Code</b>: ${S.local ? `<button class="btn sm primary" data-hooks="install">Install live hooks</button>` : 'run <code>cortex hooks install</code> on your computer'}. Every step streams here automatically, and your messages reach Claude while it works.</li>
        <li><b>Any MCP agent</b> (Claude Desktop, Cursor, Codex…): connect Cortex from the Agents tab. Cortex tells agents to call <code>live_update</code> as they work.</li>
      </ul></div>`;
    return;
  }
  el.innerHTML = LIVE.sessions.map(sessionCard).join('');
  $$('[data-msg]', el).forEach((i) => { i.value = LIVE.drafts[i.dataset.msg] || ''; i.oninput = () => (LIVE.drafts[i.dataset.msg] = i.value); });
  if (focusId) { const i = el.querySelector(`[data-msg="${CSS.escape(focusId)}"]`); if (i) { i.focus(); i.setSelectionRange(caret, caret); } }
  $$('[data-log]', el).forEach((d) => (d.ontoggle = () => (LIVE.open[d.dataset.log] = d.open)));
  $$('[data-msg-form]', el).forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const id = f.dataset.msgForm;
    const text = (LIVE.drafts[id] || '').trim();
    if (!text) return;
    try { await api('/api/live/message', { method: 'POST', body: { session: id, text } }); LIVE.drafts[id] = ''; toast('Sent: the agent gets it at its next step'); updateLive(); } catch (er) { fail(er); }
  }));
}
async function installHooks(action) {
  try {
    const r = await api('/api/integrations/claude-code', { method: 'POST', body: { action } });
    toast(r.installed ? 'Claude Code hooks installed. Restart Claude Code to start streaming.' : 'Claude Code hooks removed');
    if (S.route[0] === 'settings') renderSettings(); else renderSessions();
  } catch (e) { fail(e); }
}
function showRestarting() {
  if ($('#restart-ov')) return;
  $('#modal-root').innerHTML = `<div class="overlay" id="restart-ov"><div class="modal" style="padding:28px;text-align:center"><div class="spinner" style="width:22px;height:22px"></div><h2 style="margin:12px 0 4px">Restarting Cortex…</h2><p class="muted">This takes a few seconds.</p></div></div>`;
  const t0 = Date.now();
  const poll = async () => {
    await new Promise((r) => setTimeout(r, 1200));
    try { const r = await fetch('/api/state', { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} }); if (r.ok && Date.now() - t0 > 1500) return location.reload(); } catch { /* still down */ }
    if (Date.now() - t0 < 90000) poll(); else { closeModal(); toast('Cortex did not come back. Check the terminal window.', true); }
  };
  poll();
}

// ---------- SETTINGS ----------
const toggleRow = (id, on, title, desc, disabled) => `<label class="toggle-row ${disabled ? 'disabled' : ''}"><div><b>${title}</b><div class="small muted">${desc}</div></div><input type="checkbox" class="switch" data-setting="${id}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
function updStatus(up) {
  if (!up) return '';
  const p = up.pending;
  const notes = [];
  if (p && p.rolledBack) notes.push(`⚠ Version ${esc(p.failedVersion)} failed to start, so Cortex rolled back to ${esc(p.from)}.`);
  else if (p && p.confirmed && p.to === up.current && Date.now() - new Date(p.ts).getTime() < 7 * 864e5) notes.push(`✓ Updated from ${esc(p.from)} ${timeAgo(p.ts)}`);
  if (up.installing) notes.push('Installing update…');
  else if (up.checking) notes.push('Checking for updates…');
  else if (up.error) notes.push(esc(up.error));
  else if (up.info) notes.push(up.info.available ? `<b style="color:var(--accent)">Version ${esc(up.info.latest)} is available</b>` : `Up to date · checked ${timeAgo(up.last)}`);
  else notes.push('Not checked yet');
  return notes.join('<br>');
}
async function renderSettings() {
  let c; let st; let up = null;
  try { [c, st] = await Promise.all([S.config ? Promise.resolve(S.config) : api('/api/config'), api('/api/settings')]); S.config = c; } catch (e) { return fail(e); }
  try { up = await api('/api/update'); } catch { /* optional */ }
  if (S.route[0] !== 'settings') return;
  const L = st.local;
  const theme = document.documentElement.dataset.theme || 'system';
  const addrs = (st.remote && st.remote.addresses) || [];
  const listeningRemote = st.remote && !['127.0.0.1', 'localhost', '::1'].includes(st.remote.listening);
  let pairHtml = '';
  if (st.remote.enabled && L) {
    if (!listeningRemote) pairHtml = `<div class="empty">Restart Cortex to finish turning on phone access.${st.supervised ? ' <button class="btn sm" id="restart-now">Restart now</button>' : ' Close Cortex and start it again.'}</div>`;
    else if (!addrs.length) pairHtml = '<div class="empty">No network connection found. Connect this computer to Wi-Fi or Tailscale.</div>';
    else pairHtml = `
      <div class="pair">
        <div class="qr" id="qr"></div>
        <div class="pair-info">
          <div class="field"><label>Connect over</label><select class="input" id="pair-addr">${addrs.map((a, i) => `<option value="${i}">${a.kind === 'tailscale' ? 'Tailscale (works anywhere)' : 'Wi-Fi / home network'} · ${esc(a.ip)}</option>`).join('')}</select></div>
          <ol class="small" style="padding-left:18px;margin:4px 0"><li>Scan the QR code with your phone's camera.</li><li>Open the link. Your phone stays paired.</li><li>Optional: <b>Share → Add to Home Screen</b> for an app icon.</li></ol>
          <div class="code"><pre id="pair-url"></pre><button class="btn sm copy" id="pair-copy">${icon('i-copy')}</button></div>
          <button class="btn sm danger" id="rotate">Unpair all devices</button>
        </div>
      </div>
      <p class="small muted">Works on the same Wi-Fi out of the box. To connect from anywhere (e.g. on mobile data), install the free <b>Tailscale</b> app on this computer and your phone, sign in on both, then pick the Tailscale address above. Tailscale encrypts the connection; plain Wi-Fi does not, so only pair on networks you trust.</p>`;
  }
  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Cortex v${esc(c.version)}${L ? '' : ' · on this device you can view settings; change them on your computer'}</p></div></div>
    <div class="settings-grid">
      <div class="panel"><h3>${icon('i-phone')} Phone access</h3>
        ${toggleRow('remote', st.remote.enabled, 'Allow my phone to connect', 'Use the dashboard from your phone: watch agents and your screen live, send agents messages, manage tasks and notes.', !L)}
        ${pairHtml}
      </div>
      <div class="panel"><h3>${icon('i-live')} Screen sharing</h3>
        ${toggleRow('screen', st.screen.enabled, "Show this computer's screen on the Live page", 'Streams about 1 frame per second to paired devices while the Live page is open. Agents can also capture it with live_screenshot. This computer shows a notice whenever a phone is watching.', !L)}
        ${L && st.screen.enabled ? `<button class="btn sm" id="scr-test">Test screen capture</button>` : ''}
        <p class="small muted">macOS: the first time, allow <b>Screen Recording</b> for Terminal (or Node) in System Settings → Privacy &amp; Security, then restart Cortex. Linux needs gnome-screenshot, grim, scrot or ImageMagick.</p>
      </div>
      <div class="panel"><h3>${icon('i-update')} Updates</h3>
        <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:10px"><div><b>Version ${esc(c.version)}</b><div class="small muted" id="upd-status">${updStatus(up)}</div></div>
          ${L ? `<div class="row" style="gap:6px"><button class="btn sm" id="upd-check">Check now</button>${up && up.info && up.info.available ? `<button class="btn sm primary" id="upd-apply">Install ${esc(up.info.latest)}</button>` : ''}</div>` : ''}</div>
        ${toggleRow('auto', st.updates.auto, 'Install updates automatically', 'Checks every few hours, installs new versions and restarts by itself. If a new version fails to start, Cortex rolls back to the previous one.', !L)}
        ${L ? `<div class="field" style="margin-top:10px"><label>Update source</label><div class="row"><input class="input" id="upd-src" placeholder="your-github-name/cortex  or  https://…/latest.json" value="${esc(st.updates.source)}"><button class="btn" id="upd-save">Save</button></div><span class="small muted">The GitHub repository where Cortex releases are published.</span></div>` : ''}
        ${up && up.info && up.info.available && up.info.notes ? `<details style="margin-top:8px"><summary class="small">What's new in ${esc(up.info.latest)}</summary><div class="prose small" style="padding:8px 0">${md(up.info.notes)}</div></details>` : ''}
      </div>
      <div class="panel"><h3>${icon('i-agents')} Claude Code live view</h3>
        <p class="small" style="margin-top:0">Streams every step Claude Code takes to the Live page automatically. Messages you send from your phone reach Claude at its next step, or when it finishes its turn.</p>
        ${L ? `<div class="row"><span class="chip">${st.claudeHooks.installed ? '✓ Installed' : 'Not installed'}</span>${st.claudeHooks.installed ? '<button class="btn sm" data-hooks="uninstall">Uninstall</button>' : '<button class="btn sm primary" data-hooks="install">Install</button>'}</div>
          <p class="small muted">Adds hooks to <code>${esc(st.claudeHooks.settingsFile)}</code> (a backup is saved) and a <code>cortex</code> skill. Restart Claude Code afterwards.</p>` : '<p class="small muted">Install this from your computer.</p>'}
      </div>
      <div class="panel"><h3>Vault</h3>
        <div class="field"><label>Location</label><div class="code"><pre>${esc(c.vault)}</pre><button class="btn sm copy" id="cp-vault">${icon('i-copy')}</button></div></div>
        <p class="small muted">Everything is stored as plain Markdown here: <code>projects/</code>, <code>tasks/</code>, <code>notes/</code>. You can open this folder as a vault in Obsidian; changes sync both ways within about 2 seconds. Deleted items go to <code>.cortex/trash</code>.</p>
        <button class="btn sm" id="rescan">Rescan vault now</button>
      </div>
      <div class="panel"><h3>Appearance</h3>
        <div class="seg">${['system', 'dark', 'light'].map((t) => `<button data-theme-set="${t}" class="${theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
        <p class="small" style="margin-top:14px"><kbd>Ctrl K</kbd> command palette · <kbd>N</kbd> new task · <kbd>M</kbd> new memory · <kbd>G</kbd> then <kbd>H/L/P/B/M/G/A</kbd> to navigate</p>
        <p class="small muted">Install as an app: in Chrome or Edge use the install icon in the address bar. On a phone, use Share → Add to Home Screen.</p>
      </div>
    </div>`;
  $$('[data-setting]').forEach((cb) => (cb.onchange = async () => {
    const on = cb.checked;
    const body = cb.dataset.setting === 'remote' ? { remote: { enabled: on } } : cb.dataset.setting === 'screen' ? { screen: { enabled: on } } : { updates: { auto: on } };
    try {
      const r = await api('/api/settings', { method: 'POST', body });
      if (r.restarting) showRestarting(); else { if (r.needsManualRestart) toast('Restart Cortex to apply this change'); renderSettings(); }
    } catch (e) { fail(e); cb.checked = !on; }
  }));
  const qrEl = $('#qr');
  if (qrEl && window.qrcode) {
    const draw = () => {
      const a = addrs[Number($('#pair-addr').value) || 0];
      const url = `${a.url}/?token=${encodeURIComponent(st.remote.token)}#/live`;
      const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
      $('#pair-url').textContent = url;
      $('#pair-copy').onclick = () => copy(url);
    };
    $('#pair-addr').onchange = draw;
    draw();
  }
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('restart-now', () => api('/api/restart', { method: 'POST' }).then((r) => (r.restarting ? showRestarting() : toast('Restart Cortex manually'))).catch(fail));
  on('rotate', async () => { if (!confirm('Unpair all phones and devices? You will need to scan a new QR code.')) return; await api('/api/settings', { method: 'POST', body: { rotateToken: true } }).catch(fail); renderSettings(); });
  on('scr-test', () => modal(`<div class="modal-head"><h2>Screen capture test</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div><div class="modal-body"><img src="/api/screen?t=${Date.now()}" style="width:100%;border-radius:10px;border:1px solid var(--line)" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'empty',textContent:'Capture failed. See the notes in Settings.'}))"></div>`));
  on('upd-check', async () => { $('#upd-status').textContent = 'Checking…'; await api('/api/update/check', { method: 'POST' }).catch(fail); renderSettings(); });
  on('upd-apply', async () => {
    $('#upd-status').textContent = 'Downloading and installing…';
    try { const r = await api('/api/update/apply', { method: 'POST' }); if (r.restarted) showRestarting(); else toast(`Installed ${r.to}. Restart Cortex to use it.`); } catch (e) { fail(e); renderSettings(); }
  });
  on('upd-save', async () => { await api('/api/settings', { method: 'POST', body: { updates: { source: $('#upd-src').value } } }).catch(fail); toast('Update source saved'); await api('/api/update/check', { method: 'POST' }).catch(() => {}); renderSettings(); });
  on('cp-vault', () => copy(c.vault));
  on('rescan', () => api('/api/rescan', { method: 'POST' }).then((r) => { toast(`Rescanned · ${r.items} items`); refresh(); }).catch(fail));
  $$('[data-theme-set]').forEach((b) => (b.onclick = () => { setTheme(b.dataset.themeSet); renderSettings(); }));
}
function setTheme(t) {
  if (t === 'system') { delete document.documentElement.dataset.theme; store.set('theme', null); try { localStorage.removeItem('cortex.theme'); } catch { /* */ } }
  else { document.documentElement.dataset.theme = t; try { localStorage.setItem('cortex.theme', t); } catch { /* */ } }
}

// ---------- modal & palette ----------
function modal(html, setup) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`;
  const ov = root.firstElementChild;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  $$('[data-close]', ov).forEach((b) => (b.onclick = closeModal));
  setup && setup(ov);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function palette() {
  const actions = [
    { t: 'New task', k: 'action', run: () => openTask(null) },
    { t: 'New memory', k: 'action', run: () => newNote() },
    { t: 'New project', k: 'action', run: () => projectModal() },
    ...NAV.map(([k, l]) => ({ t: 'Go to ' + l, k: 'navigate', run: () => go(k) })),
    { t: 'Toggle theme', k: 'action', run: () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light') },
  ];
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="palette"><input id="pal-in" placeholder="Search memories, tasks, projects… or type a command" autocomplete="off"><div class="pal-list" id="pal-list"></div></div></div>`;
  const ov = root.firstElementChild;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  const input = $('#pal-in');
  let items = [];
  let idx = 0;
  let seq = 0;
  const draw = () => {
    $('#pal-list').innerHTML = items.length ? items.map((it, i) => `${it.sec ? `<div class="pal-sec">${it.sec}</div>` : ''}<div class="pal-item ${i === idx ? 'on' : ''}" data-i="${i}"><div style="min-width:0"><div>${esc(it.t)}</div>${it.s ? `<div class="s">${esc(it.s)}</div>` : ''}</div><span class="k">${esc(it.k)}</span></div>`).join('') : '<div class="empty" style="margin:8px">No results</div>';
    $$('.pal-item').forEach((el) => { el.onmousemove = () => { if (idx !== +el.dataset.i) { idx = +el.dataset.i; draw(); } }; el.onclick = () => run(+el.dataset.i); });
    const on = $('.pal-item.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => { const it = items[i]; if (!it) return; closeModal(); it.run(); };
  const update = async () => {
    const q = input.value.trim().toLowerCase();
    const my = ++seq;
    const acts = actions.filter((a) => !q || a.t.toLowerCase().includes(q));
    let results = [];
    if (q) {
      try { results = await api('/api/search?q=' + encodeURIComponent(q)); } catch { results = []; }
      if (my !== seq) return;
    } else {
      results = [...S.notes.slice(0, 5), ...S.tasks.filter((t) => t.status === 'doing').slice(0, 4)].map((x) => ({ id: x.id, kind: x.kind, title: x.title, snippet: x.excerpt || '' }));
    }
    items = [
      ...results.map((r, i) => ({ t: r.title, s: r.snippet, k: r.kind, sec: i === 0 ? (q ? 'Results' : 'Recent') : '', run: () => openItem(r.id) })),
      ...acts.map((a, i) => ({ ...a, sec: i === 0 ? 'Commands' : '' })),
    ];
    if (q && !results.length) items.push({ t: `Create memory “${input.value.trim()}”`, k: 'create', run: () => newNote({ title: input.value.trim() }) });
    idx = 0;
    draw();
  };
  input.oninput = () => { clearTimeout(update.t); update.t = setTimeout(update, 90); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { run(idx); e.preventDefault(); }
    else if (e.key === 'Escape') closeModal();
  };
  input.focus();
  update();
}

// ---------- global events ----------
document.addEventListener('click', (e) => {
  const lt = e.target.closest('[data-hooks],[data-live-del],[data-snap]');
  if (lt) {
    if (lt.dataset.hooks) installHooks(lt.dataset.hooks);
    else if (lt.dataset.liveDel) { if (confirm('Dismiss this session from the Live view?')) api('/api/live?id=' + encodeURIComponent(lt.dataset.liveDel), { method: 'DELETE' }).then(updateLive).catch(fail); }
    else if (lt.dataset.snap) modal(`<div class="modal-head"><h2>Snapshot</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div><div class="modal-body"><img src="${lt.dataset.snap}" style="width:100%;border-radius:10px"></div>`);
    return;
  }
  const t = e.target.closest('[data-go],[data-act],[data-task],[data-open],[data-create],.wikilink,[data-tag]');
  if (!t) return;
  if (t.matches('.wikilink')) { e.preventDefault(); const hit = resolveRef(t.dataset.ref); if (hit) openItem(hit.id); else if (confirm(`Create a note called "${t.dataset.ref}"?`)) newNote({ title: t.dataset.ref }); return; }
  if (t.dataset.tag !== undefined && !t.dataset.go) { const f = memFilters(); f.tag = t.dataset.tag; f.q = ''; store.set('memFilters', f); closeModal(); go('memory'); if (S.route[0] === 'memory') renderMemory(); return; }
  if (t.dataset.go !== undefined) { closeModal(); go(t.dataset.go); return; }
  if (t.dataset.task) { openTask(t.dataset.task); return; }
  if (t.dataset.open) { closeModal(); openItem(t.dataset.open); return; }
  if (t.dataset.create) { newNote({ title: t.dataset.create }); return; }
  const act = t.dataset.act;
  if (act === 'new-project') projectModal();
  else if (act === 'edit-project') projectModal(t.dataset.id);
  else if (act === 'new-task') openTask(null, { project: S.route[0] === 'board' ? store.get('boardProject', '') : undefined });
  else if (act === 'new-note') newNote(t.dataset.project ? { project: t.dataset.project } : {});
});
$('#search-btn').onclick = palette;
$('#theme-btn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  setTheme(cur === 'light' ? 'dark' : 'light');
  if (S.route[0] === 'graph') renderGraph();
};
let gPending = false;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (ED.item) { ED.dirty = true; saveNote(); } return; }
  if (e.key === 'Escape' && $('#modal-root').innerHTML) { closeModal(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $('#modal-root').innerHTML;
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (gPending) { gPending = false; const map = { l: 'live', h: 'home', p: 'projects', b: 'board', m: 'memory', g: 'graph', a: 'agents', s: 'settings' }; if (map[k]) go(map[k]); return; }
  if (k === 'g') { gPending = true; setTimeout(() => (gPending = false), 900); }
  else if (k === 'n') openTask(null);
  else if (k === 'm') newNote();
  else if (k === '/') { e.preventDefault(); palette(); }
});
window.addEventListener('beforeunload', () => { if (ED.dirty) saveNote(); });

function tick() { const d = new Date(); $('#clock').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
setInterval(tick, 10000); tick();
setInterval(() => { if (S.route[0] === 'home') { const f = $('.feed'); if (f && !document.hidden) renderHome(); } }, 60000);

// ---------- boot ----------
(async function boot() {
  parseRoute();
  await refresh();
  if (!S.local && !location.hash.replace(/^#\/?/, '')) { history.replaceState(null, '', location.pathname + location.search + '#/live'); parseRoute(); }
  fetchLive().then(renderNav).catch(() => {});
  render();
  connectEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
