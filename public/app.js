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
// Model suggestions per agent (free text is allowed too). Claude Code aliases always point at the latest model.
const AGENT_MODELS = { claude: ['opus', 'sonnet', 'haiku'], codex: [] };
const PALETTE = ['#8b7cf6', '#4f9cf9', '#3fc5d6', '#3ecf8e', '#f5b84b', '#f2676b', '#ec6fcf', '#a3e635'];
const NAV = [
  ['home', 'Home', 'i-home', 'Workspace'], ['projects', 'Projects', 'i-projects'], ['board', 'Board', 'i-board'],
  ['memory', 'Memory vault', 'i-memory', 'Knowledge'], ['graph', 'Neural map', 'i-graph'], ['mind', 'Mind', 'i-mind'], ['skills', 'Skills', 'i-skills'],
  ['live', 'Live', 'i-live', 'Agents'], ['agents', 'Agents', 'i-agents'], ['settings', 'Settings', 'i-settings'],
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
  const all = [...S.notes, ...S.tasks, ...S.projects, ...(S.mind || [])];
  return all.find((x) => x.id.toLowerCase() === r) || all.find((x) => x.slug.toLowerCase() === r) || all.find((x) => x.title.toLowerCase() === r) || null;
}
function openItem(id) {
  const it = [...S.notes, ...S.tasks, ...S.projects, ...(S.mind || [])].find((x) => x.id === id) || resolveRef(id);
  if (!it) return toast('Not found: ' + id, true);
  if (it.kind === 'task') return openTask(it.id);
  if (it.kind === 'project') return go('projects/' + it.slug);
  if (it.kind === 'mind') return openMind(it.id);
  if (it.kind === 'skill') return go('skills');
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
  const counts = { board: S.stats.openTasks, memory: S.stats.notes, projects: S.stats.projects, live: S.liveCount, mind: S.stats.mindQueued };
  $('#nav').innerHTML = NAV.map(([k, label, ic, sec]) => `${sec ? `<div class="nav-sec">${sec}</div>` : ''}<button class="dock-btn ${S.route[0] === k ? 'active' : ''}" data-go="${k}">${icon(ic)}<span>${label}</span>${counts[k] ? `<span class="count">${counts[k]}</span>` : ''}</button>`).join('');
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
  if (render.last !== v) { main.classList.remove('view-in'); void main.offsetWidth; main.classList.add('view-in'); render.last = v; }
  ({ mind: renderMind, skills: renderSkills, live: renderLive, home: renderHome, projects: renderProjects, board: renderBoard, memory: renderMemory, graph: renderGraph, agents: renderAgents, settings: renderSettings }[v])();
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
  else if (['graph', 'settings', 'live', 'agents', 'skills'].includes(S.route[0])) { renderNav(); }
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
    if (ev.type === 'commands') { if (S.route[0] === 'agents') renderAgents(); return; }
    if (ev.type === 'tunnel') { if (S.route[0] === 'settings') renderSettings(); return; }
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
async function loadInsights() {
  try { [S.briefing, S.health] = await Promise.all([api('/api/briefing'), api('/api/health')]); } catch { /* optional */ }
  if (S.route[0] === 'home') { const b = $('#brief-box'); if (b) b.innerHTML = briefingHtml(); const h = $('#health-box'); if (h) h.innerHTML = healthHtml(); }
}
function briefingHtml() {
  const b = S.briefing;
  if (!b) return '<div class="empty">Loading…</div>';
  return `<div class="prose" style="padding:0;max-height:340px;overflow:auto">${md(b.markdown.replace(/^# .*\n/, ''))}</div>`;
}
function healthHtml() {
  const h = S.health || [];
  if (!h.length) return '<div class="empty">Create a project to see how well agents are recording what they learn.</div>';
  return h.map((x) => `<div class="proj-row" data-go="projects/${esc(x.project)}"><div class="top"><span class="pdot" style="background:${x.color || 'var(--violet)'};color:${x.color || 'var(--violet)'}"></span><b>${esc(x.title)}</b><span class="small muted">${x.memories} memor${x.memories === 1 ? 'y' : 'ies'} · ${x.sessions} agent session${x.sessions === 1 ? '' : 's'}</span><span class="chip ${x.score >= 80 ? 'ok' : 'warn'}">${x.score}</span></div>
    <div class="bar"><i style="width:${x.score}%"></i></div>${x.issues.length ? `<div class="small muted" style="margin-top:6px">${esc(x.issues[0])}${x.issues.length > 1 ? ` (+${x.issues.length - 1} more)` : ''}</div>` : ''}</div>`).join('');
}
function renderHome() {
  loadInsights();
  const h = new Date().getHours();
  const greet = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const active = S.tasks.filter((t) => t.status === 'doing' || t.status === 'blocked');
  const upNext = S.tasks.filter((t) => t.status === 'todo').slice(0, 6);
  const st = S.stats;
  main.innerHTML = `
    <div id="approvals">${approvalsHtml()}</div>
    <div class="hero"><div class="eyebrow">Cortex · neural workspace</div><h1>${greet}, <span class="grad">explorer</span>.</h1><p>${st.openTasks || 0} open tasks across ${st.projects || 0} active projects · ${st.agents || 0} agents have used your memory.</p></div>
    <div class="tiles">
      <div class="tile" data-go="projects"><div class="k">Active projects</div><div class="v">${st.projects || 0}</div><div class="s">${S.projects.length} total</div></div>
      <div class="tile" data-go="board"><div class="k">Open tasks</div><div class="v">${st.openTasks || 0}</div><div class="s">${st.doneTasks || 0} completed</div></div>
      <div class="tile" data-go="memory"><div class="k">Memories</div><div class="v">${st.notes || 0}</div><div class="s">Markdown notes in vault</div></div>
      <div class="tile" data-go="agents"><div class="k">Agent actions · 24h</div><div class="v">${st.actions24h || 0}</div><div class="s">${st.agents || 0} agents seen</div></div>
    </div>
    <div class="home-grid" style="margin-bottom:18px">
      <div class="panel"><h3>${icon('i-sun')} Daily briefing <button class="btn sm ghost" id="brief-save" title="Save as a memory">Save</button></h3><div id="brief-box">${briefingHtml()}</div></div>
      <div class="panel"><h3>${icon('i-brain')} Knowledge health <span class="small muted" style="text-transform:none;letter-spacing:0;font-weight:400">are agents recording what they learn?</span></h3><div id="health-box">${healthHtml()}</div></div>
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
  const bs = $('#brief-save');
  if (bs) bs.onclick = () => api('/api/briefing/save', { method: 'POST' }).then(() => toast('Briefing saved to the memory vault')).catch(fail);
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
      <button class="btn primary" data-act="send-agent" data-project="${esc(p.slug)}">${icon('i-bolt')} Send an agent</button>
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
        ${p.instructions ? `<div class="panel"><h3>${icon('i-agents')} Agent instructions</h3><div class="prose" style="padding:0">${md(p.instructions)}</div></div>` : `<div class="panel"><h3>${icon('i-agents')} Agent instructions</h3><div class="empty">No instructions yet. <button class="btn sm" data-act="edit-project" data-id="${esc(p.id)}">Add some</button></div></div>`}
        <div class="panel"><h3>Project memories <span class="small muted" style="text-transform:none;letter-spacing:0;font-weight:400">notes/${esc(slug)}/</span><button class="btn sm ghost" data-act="new-note" data-project="${esc(slug)}">${icon('i-plus')} New</button></h3>
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
async function loadTemplates() { if (!S.templates) S.templates = await api('/api/templates').catch(() => []); }
async function projectModal(id) {
  await loadTemplates();
  const p = id ? S.projects.find((x) => x.id === id) : null;
  let color = p?.color || PALETTE[S.projects.length % PALETTE.length];
  modal(`
    <div class="modal-head"><h2>${p ? 'Edit project' : 'New project'}</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div>
    <div class="modal-body">
      <input class="input title-in" id="m-title" placeholder="Project name" value="${esc(p?.title || '')}">
      <input class="input" id="m-desc" placeholder="One-line description" value="${esc(p?.description || '')}">
      ${p ? '' : `<div class="field"><label>Start from a template</label><select class="input" id="m-tpl"><option value="">Blank project</option>${(S.templates || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}: ${esc(t.description)}</option>`).join('')}</select></div>`}
      <div class="field"><label>Agent instructions: every agent working on this project follows these</label><textarea class="input" id="m-ins" rows="4" placeholder="e.g. Always run the tests. Never change the database schema without asking.">${esc(p?.instructions || '')}</textarea></div>
      <div class="grid2"><div class="field"><label>Default agent for this project</label><select class="input" id="m-agent"><option value="">Claude Code (default)</option><option value="claude" ${p?.agent_tool === 'claude' ? 'selected' : ''}>Claude Code</option><option value="codex" ${p?.agent_tool === 'codex' ? 'selected' : ''}>Codex</option></select></div>
        <div class="field"><label>Default model (optional)</label><input class="input" id="m-model" list="m-models" autocomplete="off" placeholder="e.g. sonnet" value="${esc(p?.agent_model || '')}"><datalist id="m-models">${AGENT_MODELS.claude.map((mm) => `<option value="${mm}">`).join('')}</datalist></div></div>
      <span class="small muted" style="display:block;margin:-4px 0 8px">Agents started from Cortex for this project use these unless you pick something else when starting one.</span>
      <div class="field"><label>Code folder on this computer (optional)</label><input class="input" id="m-folder" placeholder="C:\\Users\\you\\Desktop\\My Project" value="${esc(p?.folder || '')}"><span class="small muted">Claude Code sessions in this folder are filed under this project automatically.</span></div>
      <div class="field"><label>Color</label><div class="row" id="m-colors">${PALETTE.map((c) => `<button type="button" data-c="${c}" style="width:26px;height:26px;border-radius:8px;border:2px solid ${c === color ? 'var(--text)' : 'transparent'};background:${c};cursor:pointer"></button>`).join('')}</div></div>
      <div class="field"><label>Overview (Markdown)</label><textarea class="input" id="m-body" rows="7" placeholder="Goals, context, links to notes with [[wikilinks]]…">${esc(p?.body || '')}</textarea></div>
    </div>
    <div class="modal-foot">${p ? `<button class="btn danger" id="m-del">${icon('i-trash')} Delete</button>` : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="m-save">${p ? 'Save' : 'Create project'}</button></div>`,
  (root) => {
    $$('#m-colors button', root).forEach((b) => (b.onclick = () => { color = b.dataset.c; $$('#m-colors button', root).forEach((x) => (x.style.borderColor = x.dataset.c === color ? 'var(--text)' : 'transparent')); }));
    $('#m-title', root).focus();
    $('#m-save', root).onclick = async () => {
      const body = { title: $('#m-title', root).value, description: $('#m-desc', root).value, color, body: $('#m-body', root).value, instructions: $('#m-ins', root).value, folder: $('#m-folder', root).value.trim() || null, agent_tool: $('#m-agent', root).value || null, agent_model: $('#m-model', root).value.trim() || null };
      try {
        const tpl = !p && $('#m-tpl', root) ? $('#m-tpl', root).value : '';
        if (p) await api('/api/items', { method: 'PATCH', body: { id: p.id, ...body } });
        else if (tpl) {
          const r = await api('/api/templates', { method: 'POST', body: { template: tpl, title: body.title, description: body.description || undefined, folder: body.folder || undefined } });
          if (body.agent_tool || body.agent_model) await api('/api/items', { method: 'PATCH', body: { id: 'projects/' + r.slug, agent_tool: body.agent_tool, agent_model: body.agent_model, quiet: true } });
          go('projects/' + r.slug);
        }
        else { const r = await api('/api/items', { method: 'POST', body: { kind: 'project', ...body, folder: body.folder || undefined, agent_tool: body.agent_tool || undefined, agent_model: body.agent_model || undefined } }); go('projects/' + r.slug); }
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
    <div class="modal-foot">${t ? `<button class="btn danger" id="t-del">${icon('i-trash')} Delete</button><button class="btn" data-act="send-agent" data-task="${esc(t.id)}" data-project="${esc(t.project || '')}">${icon('i-bolt')} Send to an agent</button>` : ''}<span class="spacer"></span><span class="muted small">Ctrl+Enter to save</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="t-save">${t ? 'Save' : 'Create task'}</button></div>`,
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
function memFilters() { return { q: '', type: '', project: '', tag: '', scope: 'project', ...store.get('memFilters', {}) }; }
function filteredNotes() {
  const f = memFilters();
  const q = f.q.toLowerCase();
  const scopeOk = (n) => (f.scope === 'system' ? !n.project : f.scope === 'project' ? !!n.project && (!f.project || n.project === f.project) : true);
  return S.notes.filter((n) => scopeOk(n) && (!f.type || (n.type || 'note') === f.type) && (!f.tag || (n.allTags || []).includes(f.tag))
    && (!q || (n.title + ' ' + n.excerpt + ' ' + (n.allTags || []).join(' ')).toLowerCase().includes(q)));
}
function renderMemory() {
  const f = memFilters();
  const allTags = [...new Set(S.notes.flatMap((n) => n.allTags || []))].sort();
  main.innerHTML = `
    <div class="mem ${S.route[1] ? 'has-sel' : ''}">
      <div class="mem-side glass">
        <div class="mem-filters">
          <div class="seg" style="width:100%">${[['project', 'Project memories'], ['system', 'System memories']].map(([k, l]) => `<button data-mscope="${k}" class="${f.scope === k ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>
          <div class="small muted" style="padding:0 2px">${f.scope === 'system' ? 'Apply to every project · stored in <code>notes/</code>' : 'Apply only to their project · stored in <code>notes/&lt;project&gt;/</code>'}</div>
          <div class="row"><input class="input" id="mf-q" placeholder="Filter memories…" value="${esc(f.q)}"><button class="btn primary" data-act="new-note" ${f.scope === 'project' && f.project ? `data-project="${esc(f.project)}"` : ''} title="New memory">${icon('i-plus')}</button></div>
          <div class="row" style="gap:6px">
            <select class="input" id="mf-type"><option value="">All types</option>${opts(TYPES, f.type)}</select>
            ${f.scope === 'project' ? `<select class="input" id="mf-proj">${projectOptions(f.project, 'All projects')}</select>` : ''}
          </div>
          ${allTags.length ? `<select class="input" id="mf-tag"><option value="">All tags</option>${allTags.map((t) => `<option ${t === f.tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="mem-list" id="mem-list"></div>
      </div>
      <div class="mem-main glass" id="mem-main"></div>
    </div>`;
  const setF = (k, v) => { const ff = memFilters(); ff[k] = v; store.set('memFilters', ff); renderMemList(); };
  $$('[data-mscope]').forEach((b) => (b.onclick = () => { const ff = memFilters(); ff.scope = b.dataset.mscope; store.set('memFilters', ff); renderMemory(); }));
  $('#mf-q').oninput = (e) => setF('q', e.target.value);
  $('#mf-type').onchange = (e) => setF('type', e.target.value);
  if ($('#mf-proj')) $('#mf-proj').onchange = (e) => { const ff = memFilters(); ff.project = e.target.value; store.set('memFilters', ff); renderMemory(); };
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
      <div class="t">${n.pinned ? `<span style="color:var(--accent)">${icon('i-pin')}</span>` : `<span class="node" style="background:${nodeColor({ kind: 'note', type: n.type })};color:${nodeColor({ kind: 'note', type: n.type })}"></span>`}<span>${esc(n.title)}</span></div>
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
function sideLinksHtml(n) {
  const row = (id, title, cls = '') => `<div class="lk ${cls}" ${cls === 'broken' ? `data-create="${esc(title)}" title="Create this note"` : `data-open="${esc(id)}"`}><span class="pdot" style="color:${nodeColor(resolveRef(id) || {})};background:currentColor"></span>${esc(title)}</div>`;
  return `<h4>Links out · ${(n.links || []).length}</h4>${(n.links || []).map((l) => row(l, resolveRef(l)?.title || l)).join('') || '<div class="lk muted small">None yet</div>'}
    ${(n.broken || []).length ? `<h4>Not created yet</h4>${n.broken.map((b) => row(b, '+ ' + b, 'broken')).join('')}` : ''}
    <h4>Backlinks · ${(n.backlinks || []).length}</h4>${(n.backlinks || []).map((b) => row(b.id, b.title)).join('') || '<div class="lk muted small">Nothing links here yet</div>'}`;
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
        <button class="btn sm ghost" id="ed-hist" title="Version history">${icon('i-clock')} History</button>
        <button class="btn sm ghost danger" id="ed-del" title="Delete">${icon('i-trash')}</button>
      </div>
    </div>
    <div class="ed-wrap">
      <div class="ed-body ${ED.mode === 'split' ? 'split' : ''}">
        ${ED.mode !== 'preview' ? `<textarea id="ed-body" spellcheck="true" placeholder="Write in Markdown. Link notes with [[Note title]], tag with #tags.">${esc(n.body || '')}</textarea>` : ''}
        ${ED.mode !== 'edit' ? `<div class="prose" id="ed-prev">${md(n.body)}</div>` : ''}
      </div>
      <aside class="ed-side"><h4>Neural links</h4><div class="local-graph" id="local-graph"></div><div class="ed-links" id="ed-links">${sideLinksHtml(n)}</div></aside>
    </div>
    <div class="ed-foot"><span>${n.agent ? `Written by ${esc(n.agent)}` : 'Written by you'}</span><span class="save-state" id="ed-state">${esc(n.id)}.md · saved ${timeAgo(n.updated)}</span></div>`;
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
  $('#ed-hist').onclick = () => { if (ED.dirty) saveNote(); historyModal(n.id); };
  requestAnimationFrame(() => drawLocalGraph(n));
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
    const savedRec = await api('/api/items', { method: 'PATCH', body: { id: n.id, title: n.title, body: n.body, type: n.type, project: n.project || null, tags: n.tags, pinned: n.pinned ? true : null, quiet: true } });
    if (savedRec.id !== n.id) { ED.id = savedRec.id; ED.dirty = false; history.replaceState(null, '', '#/memory/' + encodeURIComponent(savedRec.id)); S.route[1] = savedRec.id; await refresh(); loadEditor(savedRec.id); toast(savedRec.project ? `Moved to ${savedRec.project}'s memory folder` : 'Moved to system memories'); return; }
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
  const l = $('#ed-links');
  if (l) l.innerHTML = sideLinksHtml(n);
  drawLocalGraph(n);
  const st = $('#ed-state');
  if (st) st.textContent = `Saved ✓ · ${n.id}.md`;
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

// ---------- COSMOS (animated deep-space background) ----------
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isLight = () => document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches);
(function cosmos() {
  const c = $('#cosmos');
  if (!c) return;
  const ctx = c.getContext('2d');
  let w = 0; let h = 0; let stars = []; let neurons = []; let t = 0;
  const resize = () => {
    const d = Math.min(2, window.devicePixelRatio || 1);
    w = innerWidth; h = innerHeight; c.width = w * d; c.height = h * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    stars = Array.from({ length: Math.min(420, Math.round((w * h) / 7000)) }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.15 + 0.15, a: Math.random() * 0.55 + 0.15, tw: Math.random() * 6.28, z: Math.random() * 0.8 + 0.2 }));
    neurons = Array.from({ length: Math.round(Math.min(26, w / 60)) }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12 }));
  };
  resize();
  addEventListener('resize', resize);
  const draw = () => {
    t += 1;
    ctx.clearRect(0, 0, w, h);
    const light = isLight();
    const ink = light ? '40,50,120' : '200,215,255';
    for (const s of stars) {
      const a = s.a * (0.65 + 0.35 * Math.sin(t * 0.02 * s.z + s.tw));
      ctx.fillStyle = `rgba(${ink},${light ? a * 0.35 : a})`;
      ctx.beginPath(); ctx.arc(s.x, (s.y + t * 0.015 * s.z) % h, s.r, 0, 6.283); ctx.fill();
    }
    // faint drifting neural web
    for (const n of neurons) { n.vz *= 0.6; n.x += n.vx; n.y += n.vy; n.z += n.vz; if (n.x < -40) n.x = w + 40; if (n.x > w + 40) n.x = -40; if (n.y < -40) n.y = h + 40; if (n.y > h + 40) n.y = -40; }
    ctx.lineWidth = 1;
    for (let i = 0; i < neurons.length; i++) {
      for (let j = i + 1; j < neurons.length; j++) {
        const a = neurons[i]; const b = neurons[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 260) continue;
        const al = (1 - d / 260) * (light ? 0.10 : 0.13);
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, `rgba(139,107,255,${al})`); g.addColorStop(1, `rgba(71,227,255,${al})`);
        ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    for (const n of neurons) { ctx.fillStyle = light ? 'rgba(90,80,220,0.25)' : 'rgba(150,200,255,0.35)'; ctx.beginPath(); ctx.arc(n.x, n.y, 1.6, 0, 6.283); ctx.fill(); }
  };
  if (REDUCED) { draw(); addEventListener('resize', draw); return; }
  const loop = () => { if (!document.hidden) draw(); setTimeout(() => requestAnimationFrame(loop), 40); };
  loop();
})();

// ---------- NEURAL rendering helpers (vault graph + local graph) ----------
const NOTE_COLORS = { memory: '#5ce1ff', note: '#8fb4ff', decision: '#e66bff', plan: '#9b7bff', log: '#7d8bb8', reference: '#5ca8ff', idea: '#ffd36b' };
function nodeColor(n) {
  if (n.kind === 'project') return n.color || '#9b7bff';
  if (n.kind === 'task') return n.status === 'done' ? '#3ee6a0' : n.status === 'blocked' ? '#ff6b8a' : '#ffc35c';
  if (n.kind === 'mind') return '#ff8ad8';
  return NOTE_COLORS[n.type] || '#8fb4ff';
}
function hexA(hex, a) {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(150,180,255,${a})`;
  const v = parseInt(m[1], 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
}
function curvePoint(ax, ay, bx, by, k, t) {
  const mx = (ax + bx) / 2; const my = (ay + by) / 2;
  const cx = mx - (by - ay) * k; const cy = my + (bx - ax) * k;
  const u = 1 - t;
  return [u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by, cx, cy];
}
function drawNeuron(ctx, x, y, r, col, intensity = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4.2);
  g.addColorStop(0, hexA(col, 0.55 * intensity)); g.addColorStop(0.35, hexA(col, 0.16 * intensity)); g.addColorStop(1, hexA(col, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4.2, 0, 6.283); ctx.fill();
  const core = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
  core.addColorStop(0, `rgba(255,255,255,${0.95 * intensity})`); core.addColorStop(0.45, hexA(col, intensity)); core.addColorStop(1, hexA(col, 0.6 * intensity));
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
}

// ---------- GRAPH: the neural vault ----------
let G = null;
function stopGraph() { if (G) { cancelAnimationFrame(G.raf); window.removeEventListener('resize', G.resize); G = null; } }
async function renderGraph() {
  stopGraph();
  const showTasks = store.get('gTasks', true);
  const showMind = store.get('gMind', true);
  const gscope = store.get('gScope', 'all');
  const gproj = store.get('gProj', (S.projects[0] || {}).slug || '');
  main.innerHTML = `<div class="graph-wrap view-in"><canvas id="gc" tabindex="0" aria-label="Neural vault map. Use arrow keys to orbit, plus and minus to zoom, and Home to reset."></canvas>
    <div style="position:absolute;top:18px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;z-index:2">
      <div class="seg" style="background:rgba(10,13,32,.6)">${[['project', 'Project memories'], ['system', 'System memories'], ['all', 'Everything']].map(([k, l]) => `<button data-gscope="${k}" class="${gscope === k ? 'on' : ''}" style="color:#dfe6ff">${l}</button>`).join('')}</div>
      ${gscope === 'project' ? `<select class="input" id="g-proj" style="width:auto;background:rgba(10,13,32,.6);color:#e9edff">${S.projects.map((p) => `<option value="${esc(p.slug)}" ${p.slug === gproj ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="graph-legend">
      <div class="ttl"><span>Neural vault</span></div>
      <label><span class="pdot" style="color:#9b7bff;background:#9b7bff;width:11px;height:11px"></span> Projects</label>
      <label><span class="pdot" style="color:#5ce1ff;background:#5ce1ff"></span> Memories &amp; notes</label>
      <label><input type="checkbox" id="g-tasks" ${showTasks ? 'checked' : ''}> <span class="pdot" style="color:#ffc35c;background:#ffc35c"></span> Tasks</label>
      <label><input type="checkbox" id="g-mind" ${showMind ? 'checked' : ''}> <span class="pdot" style="color:#ff8ad8;background:#ff8ad8"></span> Mind</label>
      <span class="muted small">Drag to orbit &middot; Shift-drag to pan &middot; scroll or pinch to zoom</span>
    </div>
    <div class="graph-search"><input class="input" id="g-q" placeholder="Find a neuron…" autocomplete="off"></div>
    <button class="btn sm" id="g-reset" style="position:absolute;bottom:42px;right:18px">Reset view</button>
    <div class="graph-stats" id="g-stats"></div>
    <div class="graph-tip" id="g-tip"></div></div>`;
  $('#g-tasks').onchange = (e) => { store.set('gTasks', e.target.checked); renderGraph(); };
  $$('[data-gscope]').forEach((b) => (b.onclick = () => { store.set('gScope', b.dataset.gscope); renderGraph(); }));
  if ($('#g-proj')) $('#g-proj').onchange = (e) => { store.set('gProj', e.target.value); renderGraph(); };
  $('#g-mind').onchange = (e) => { store.set('gMind', e.target.checked); renderGraph(); };
  const canvas = $('#gc');
  const data = await api('/api/graph').catch((error) => { if (canvas.isConnected) fail(error); });
  if (!data || !canvas.isConnected || S.route[0] !== 'graph') return;
  const ctx = canvas.getContext('2d');
  const inScope = (n) => gscope === 'all' ? true
    : gscope === 'system' ? n.kind === 'note' && !n.project
    : (n.kind === 'project' ? n.id === 'projects/' + gproj : n.project === gproj);
  const nodes = data.nodes.filter((n) => n.kind !== 'skill' && inScope(n) && (showTasks || n.kind !== 'task') && (showMind || n.kind !== 'mind'))
    .map((n, i, arr) => { const a = (i / arr.length) * 6.283 * 3; const r = 60 + i * 4; return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, z: Math.sin(i * 2.4) * 65, vx: 0, vy: 0, vz: 0, phase: Math.random() * 6.283 }; });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e, s: byId.get(e.source), t: byId.get(e.target), k: (Math.random() - 0.5) * 0.35 }));
  const deg = new Map();
  edges.forEach((e) => { deg.set(e.s, (deg.get(e.s) || 0) + 1); deg.set(e.t, (deg.get(e.t) || 0) + 1); });
  const radius = (n) => (n.kind === 'project' ? 9 : n.kind === 'task' ? 3.6 : 4.8) + Math.min(7, (deg.get(n) || 0) * 0.7);
  $('#g-stats').textContent = `${nodes.length} NEURONS · ${edges.length} SYNAPSES`;
  const initialView = { x: 0, y: 0, k: 1, yaw: 0.25, pitch: 0.25 };
  G = { raf: 0, alpha: 1, view: { ...initialView }, hover: null, pulses: [], q: '', t: 0 };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  G.resize = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; G.w = r.width; G.h = r.height; G.alpha = Math.max(G.alpha, 0.1); };
  G.resize();
  window.addEventListener('resize', G.resize);
  const project = (n) => {
    const { yaw, pitch } = G.view;
    const x = n.x * Math.cos(yaw) - n.z * Math.sin(yaw);
    const depth = n.x * Math.sin(yaw) + n.z * Math.cos(yaw);
    n.px = x; n.py = n.y * Math.cos(pitch) - depth * Math.sin(pitch);
    n.depth = n.y * Math.sin(pitch) + depth * Math.cos(pitch);
  };
  const pick = (px, py) => {
    let best = null;
    for (const n of nodes) {
      const x = G.w / 2 + G.view.x + n.px * G.view.k;
      const y = G.h / 2 + G.view.y + n.py * G.view.k;
      if (Math.hypot(x - px, y - py) <= radius(n) * G.view.k + 6 && (!best || n.depth > best.depth)) best = n;
    }
    return best;
  };
  const neighbors = (n) => { const s = new Set([n]); edges.forEach((e) => { if (e.s === n) s.add(e.t); if (e.t === n) s.add(e.s); }); return s; };
  const dust = Array.from({ length: 160 }, () => ({ x: (Math.random() - 0.5) * 3000, y: (Math.random() - 0.5) * 3000, r: Math.random() * 1.2 + 0.2, z: Math.random() * 0.6 + 0.2 }));
  function physics() {
    const a = G.alpha < 0.008 ? 0 : G.alpha;
    if (a <= 0) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const m = nodes[j];
        let dx = n.x - m.x; let dy = n.y - m.y;
        const dz = n.z - m.z;
        const d2 = dx * dx + dy * dy + dz * dz || 0.01;
        if (d2 > 200000) continue;
        const f = (1100 / d2) * a;
        dx *= f; dy *= f; n.vx += dx; n.vy += dy; m.vx -= dx; m.vy -= dy; n.vz += dz * f; m.vz -= dz * f;
      }
      n.vx -= n.x * 0.0035 * a; n.vy -= n.y * 0.0035 * a; n.vz -= n.z * 0.0035 * a;
      if (!REDUCED && G.alpha < 0.05) { n.vx += Math.cos(G.t * 0.01 + n.phase) * 0.012; n.vy += Math.sin(G.t * 0.012 + n.phase) * 0.012; }
    }
    for (const e of edges) {
      const dx = e.t.x - e.s.x; const dy = e.t.y - e.s.y;
      const dz = e.t.z - e.s.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const f = ((d - (e.type === 'project' ? 80 : 110)) / d) * 0.045 * a;
      e.s.vx += dx * f; e.s.vy += dy * f; e.t.vx -= dx * f; e.t.vy -= dy * f; e.s.vz += dz * f; e.t.vz -= dz * f;
    }
    for (const n of nodes) { n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy; }
    G.alpha *= 0.985;
  }
  function spawnPulses() {
    if (REDUCED || !edges.length || G.pulses.length > 60) return;
    const n = G.hover ? 3 : 1;
    for (let i = 0; i < n; i++) {
      let e = edges[(Math.random() * edges.length) | 0];
      if (G.hover) { const own = edges.filter((x) => x.s === G.hover || x.t === G.hover); if (own.length) e = own[(Math.random() * own.length) | 0]; }
      G.pulses.push({ e, t: 0, dir: Math.random() < 0.5 ? 1 : -1, speed: 0.008 + Math.random() * 0.012 });
    }
  }
  function draw() {
    G.t++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, G.w, G.h);
    // parallax dust
    for (const d of dust) {
      const x = G.w / 2 + G.view.x * d.z + d.x * d.z * G.view.k * 0.5; const y = G.h / 2 + G.view.y * d.z + d.y * d.z * G.view.k * 0.5;
      if (x < -5 || y < -5 || x > G.w + 5 || y > G.h + 5) continue;
      ctx.fillStyle = `rgba(170,190,255,${0.08 + d.z * 0.18})`; ctx.beginPath(); ctx.arc(x, y, d.r, 0, 6.283); ctx.fill();
    }
    ctx.translate(G.w / 2 + G.view.x, G.h / 2 + G.view.y);
    ctx.scale(G.view.k, G.view.k);
    nodes.forEach(project);
    const drawn = [...nodes].sort((a, b) => a.depth - b.depth);
    const hl = G.hover ? neighbors(G.hover) : null;
    const q = G.q;
    const match = (n) => q && n.title.toLowerCase().includes(q);
    ctx.globalCompositeOperation = 'lighter';
    for (const e of edges) {
      const on = hl && hl.has(e.s) && hl.has(e.t);
      const dim = (hl && !on) || (q && !match(e.s) && !match(e.t));
      const [, , cx, cy] = curvePoint(e.s.px, e.s.py, e.t.px, e.t.py, e.k, 0);
      const g = ctx.createLinearGradient(e.s.px, e.s.py, e.t.px, e.t.py);
      const al = dim ? 0.05 : on ? 0.75 : e.type === 'project' ? 0.16 : 0.3;
      g.addColorStop(0, hexA(nodeColor(e.s), al)); g.addColorStop(1, hexA(nodeColor(e.t), al));
      ctx.strokeStyle = g; ctx.lineWidth = (on ? 1.8 : 1) / G.view.k;
      ctx.beginPath(); ctx.moveTo(e.s.px, e.s.py); ctx.quadraticCurveTo(cx, cy, e.t.px, e.t.py); ctx.stroke();
    }
    // synaptic impulses
    if (G.t % 6 === 0) spawnPulses();
    G.pulses = G.pulses.filter((p) => p.t <= 1);
    for (const p of G.pulses) {
      p.t += p.speed;
      const tt = p.dir > 0 ? p.t : 1 - p.t;
      const [x, y] = curvePoint(p.e.s.px, p.e.s.py, p.e.t.px, p.e.t.py, p.e.k, tt);
      const col = nodeColor(p.dir > 0 ? p.e.t : p.e.s);
      const r = 2.2 / Math.sqrt(G.view.k);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.3, hexA(col, 0.6)); g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 5, 0, 6.283); ctx.fill();
    }
    for (const n of drawn) {
      const dim = (hl && !hl.has(n)) || (q && !match(n));
      const breathe = REDUCED ? 1 : 0.85 + 0.15 * Math.sin(G.t * 0.03 + n.phase);
      drawNeuron(ctx, n.px, n.py, radius(n) * (n === G.hover ? 1.35 : 1), nodeColor(n), dim ? 0.18 : breathe);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const n of drawn) {
      const dim = (hl && !hl.has(n)) || (q && !match(n));
      if (dim || n.kind === 'task') continue;
      if (!(G.view.k > 0.75 || n.kind === 'project' || n === G.hover || match(n) || (hl && hl.has(n)))) continue;
      const fs = (n.kind === 'project' ? 12.5 : 11) / Math.max(0.8, G.view.k);
      ctx.font = `${n.kind === 'project' ? 600 : 500} ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = n === G.hover || match(n) ? '#ffffff' : 'rgba(205,215,245,0.78)';
      ctx.shadowColor = hexA(nodeColor(n), 0.8); ctx.shadowBlur = 8;
      const label = n.title.length > 32 ? n.title.slice(0, 31) + '…' : n.title;
      ctx.fillText(label, n.px, n.py + radius(n) + 14 / Math.max(0.8, G.view.k));
      ctx.shadowBlur = 0;
    }
  }
  function loop() { if (!G) return; physics(); draw(); G.raf = requestAnimationFrame(loop); }
  const tip = $('#g-tip');
  let down = null;
  canvas.style.touchAction = 'none';
  const orbit = (dx, dy) => { G.view.yaw -= dx * 0.008; G.view.pitch += dy * 0.008; };
  canvas.onpointerdown = (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    down = { x: e.clientX, y: e.clientY, n: pick(e.clientX - r.left, e.clientY - r.top), moved: false, pan: e.shiftKey };
  };
  canvas.onpointerup = (e) => {
    if (e.pointerType === 'touch') return;
    const n = down && !down.moved && down.n;
    down = null;
    if (n) openItem(n.id);
  };
  canvas.onlostpointercapture = () => { down = null; };
  canvas.onpointermove = (e) => {
    if (e.pointerType === 'touch') return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left; const py = e.clientY - r.top;
    if (down) {
      const dx = e.clientX - down.x; const dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true; down.x = e.clientX; down.y = e.clientY;
      if (down.pan) { G.view.x += dx; G.view.y += dy; }
      else orbit(dx, dy);
      return;
    }
    G.hover = pick(px, py);
    canvas.style.cursor = G.hover ? 'pointer' : 'grab';
    if (G.hover) { tip.style.display = 'block'; tip.style.left = px + 16 + 'px'; tip.style.top = py + 12 + 'px'; tip.innerHTML = `<b>${esc(G.hover.title)}</b><br><span style="color:#8f99c4">${esc(G.hover.kind === 'note' ? G.hover.type || 'note' : G.hover.kind)}${G.hover.status ? ' · ' + esc(G.hover.status) : ''} · ${deg.get(G.hover) || 0} links</span>`; }
    else tip.style.display = 'none';
  };
  canvas.onmouseleave = () => { G.hover = null; tip.style.display = 'none'; };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left - G.w / 2; const py = e.clientY - r.top - G.h / 2;
    const k = Math.min(4, Math.max(0.2, G.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    G.view.x = px - ((px - G.view.x) * k) / G.view.k; G.view.y = py - ((py - G.view.y) * k) / G.view.k; G.view.k = k;
  };
  // touch: one finger orbits or taps, two fingers pinch
  let touch = null;
  canvas.ontouchstart = (e) => {
    const r = canvas.getBoundingClientRect();
    if (e.touches.length === 1) { const t0 = e.touches[0]; touch = { x: t0.clientX, y: t0.clientY, vx: G.view.x, vy: G.view.y, moved: false, n: pick(t0.clientX - r.left, t0.clientY - r.top) }; }
    else if (e.touches.length === 2) { const [a, b] = e.touches; touch = { pinch: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), k: G.view.k }; }
  };
  canvas.ontouchmove = (e) => {
    e.preventDefault();
    if (!touch) return;
    if (touch.pinch > 0 && e.touches.length === 2) { const [a, b] = e.touches; G.view.k = Math.min(4, Math.max(0.2, touch.k * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / touch.pinch))); return; }
    if (touch.pinch !== undefined || e.touches.length !== 1) return;
    const t0 = e.touches[0];
    const dx = t0.clientX - touch.x; const dy = t0.clientY - touch.y;
    if (!touch.moved && Math.hypot(dx, dy) < 6) return;
    touch.moved = true; touch.x = t0.clientX; touch.y = t0.clientY;
    orbit(dx, dy);
  };
  canvas.ontouchend = () => { if (touch && !touch.pinch && !touch.moved && touch.n) openItem(touch.n.id); touch = null; };
  canvas.ontouchcancel = () => { touch = null; };
  const resetView = () => { G.view = { ...initialView }; };
  $('#g-reset').onclick = resetView;
  canvas.onkeydown = (e) => {
    const directions = { ArrowLeft: [-32, 0], ArrowRight: [32, 0], ArrowUp: [0, -32], ArrowDown: [0, 32] };
    if (Object.hasOwn(directions, e.key)) orbit(...directions[e.key]);
    else if (e.key === 'Home') resetView();
    else if (e.key === '+' || e.key === '=') G.view.k = Math.min(4, G.view.k * 1.12);
    else if (e.key === '-') G.view.k = Math.max(0.2, G.view.k / 1.12);
    else return;
    e.preventDefault();
  };
  $('#g-q').oninput = (e) => {
    G.q = e.target.value.trim().toLowerCase();
    const hit = G.q && nodes.find((n) => n.title.toLowerCase().includes(G.q));
    if (hit) { G.view.x = -hit.px * G.view.k; G.view.y = -hit.py * G.view.k; }
  };
  $('#g-q').onkeydown = (e) => { if (e.key === 'Enter') { const hit = nodes.find((n) => n.title.toLowerCase().includes(G.q)); if (hit) openItem(hit.id); } };
  for (let i = 0; i < 160; i++) physics();
  loop();
}

// local neuron map shown beside a note in the vault editor
function drawLocalGraph(n) {
  const wrap = $('#local-graph');
  if (!wrap) return;
  if (wrap._raf) cancelAnimationFrame(wrap._raf);
  wrap.innerHTML = '<canvas></canvas>';
  const canvas = wrap.firstChild;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = wrap.getBoundingClientRect();
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const W = r.width; const H = r.height;
  const all = [...S.notes, ...S.tasks, ...S.projects, ...(S.mind || [])];
  const find = (id) => all.find((x) => x.id === id);
  const neigh = [];
  const seen = new Set([n.id]);
  for (const id of n.links || []) { const x = find(id); if (x && !seen.has(x.id)) { seen.add(x.id); neigh.push({ ...x, rel: 'out' }); } }
  for (const b of n.backlinks || []) { const x = find(b.id) || b; if (!seen.has(x.id)) { seen.add(x.id); neigh.push({ ...x, rel: 'in' }); } }
  if (n.project && !seen.has('projects/' + n.project)) { const p = find('projects/' + n.project); if (p) { seen.add(p.id); neigh.push({ ...p, rel: 'project' }); } }
  const cx = W / 2; const cy = H / 2;
  const R = Math.min(W, H) / 2 - 34;
  const pts = neigh.map((x, i) => { const a = (i / Math.max(1, neigh.length)) * 6.283 - 1.57; return { ...x, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.86 }; });
  const me = { ...n, kind: 'note', x: cx, y: cy };
  let t = 0;
  let hover = null;
  const pulses = [];
  const frame = () => {
    t++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of pts) {
      const g = ctx.createLinearGradient(me.x, me.y, p.x, p.y);
      g.addColorStop(0, hexA(nodeColor(me), 0.45)); g.addColorStop(1, hexA(nodeColor(p), p === hover ? 0.8 : 0.4));
      ctx.strokeStyle = g; ctx.lineWidth = p === hover ? 1.8 : 1;
      const [, , qx, qy] = curvePoint(me.x, me.y, p.x, p.y, 0.12, 0);
      ctx.beginPath(); ctx.moveTo(me.x, me.y); ctx.quadraticCurveTo(qx, qy, p.x, p.y); ctx.stroke();
    }
    if (!REDUCED && pts.length && t % 18 === 0) pulses.push({ p: pts[(Math.random() * pts.length) | 0], t: 0 });
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i]; q.t += 0.02;
      if (q.t > 1) { pulses.splice(i, 1); continue; }
      const out = q.p.rel !== 'in';
      const [x, y] = curvePoint(me.x, me.y, q.p.x, q.p.y, 0.12, out ? q.t : 1 - q.t);
      const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, hexA(nodeColor(q.p), 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.283); ctx.fill();
    }
    for (const p of pts) drawNeuron(ctx, p.x, p.y, p === hover ? 6 : 4.5, nodeColor(p), 1);
    drawNeuron(ctx, me.x, me.y, 8 + (REDUCED ? 0 : Math.sin(t * 0.05)), '#5ce1ff', 1);
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '500 10.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const p of pts) { ctx.fillStyle = p === hover ? '#fff' : 'rgba(200,210,240,0.7)'; ctx.fillText(p.title.length > 20 ? p.title.slice(0, 19) + '…' : p.title, p.x, p.y + 17); }
    if (!pts.length) { ctx.fillStyle = 'rgba(160,170,210,0.6)'; ctx.fillText('No links yet: add [[Note title]]', cx, cy + 28); }
    if (!REDUCED && $('#local-graph') === wrap) wrap._raf = requestAnimationFrame(frame);
  };
  canvas.onmousemove = (e) => { const b = canvas.getBoundingClientRect(); const x = e.clientX - b.left; const y = e.clientY - b.top; hover = pts.find((p) => Math.hypot(p.x - x, p.y - y) < 12) || null; canvas.style.cursor = hover ? 'pointer' : 'default'; if (REDUCED) frame(); };
  canvas.onclick = () => { if (hover) openItem(hover.id); };
  frame();
}

// ---------- AGENTS HUB ----------
const HUB = { sel: store.get('hubSel', ''), filter: store.get('hubFilter', { q: '', project: '', agent: '', status: 'active' }), tab: store.get('hubTab', 'launch'), data: null };
const chatStatus = (x) => (x.archived ? 'archived' : ['working', 'needs-you'].includes(x.status) ? 'active' : 'idle');
function agentUsageHtml() {
  const since = Date.now() - 864e5;
  const usageRows = Object.entries({ claude: 'Claude Code', codex: 'Codex' }).map(([tool, label]) => {
    const runs = LIVE.sessions.filter((run) => run.tool === tool && run.launched && run.usage);
    const totals = runs.reduce((sum, run) => ({
      input: sum.input + run.usage.input, output: sum.output + run.usage.output
    }), { input: 0, output: 0 });
    const recent = runs.filter((run) => Date.parse(run.started) >= since)
      .reduce((sum, run) => sum + run.usage.input + run.usage.output, 0);
    return [label, runs.length ? recent.toLocaleString() + ' tokens in 24h. ' +
      (totals.input + totals.output).toLocaleString() + ' recorded (' +
      totals.input.toLocaleString() + ' input, ' + totals.output.toLocaleString() + ' output)' : 'No token reports yet'];
  });
  return usageRows.map(([tool, total]) => `<div class="row"><b>${tool}</b><span>${total}</span></div>`).join('');
}
// Account-wide usage read from Claude Code / Codex logs on this computer (/api/usage), with quota meters.
function accountUsageHtml(u) {
  if (!u) return '<div class="small muted">Usage from this computer\'s Claude Code and Codex logs is loading…</div>';
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));
  const when = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  const meter = (label, w) => {
    if (!w) return '';
    const pct = Math.round(w.usedPercent);
    const col = pct >= 90 ? 'var(--bad, #ff6b6b)' : pct >= 70 ? 'var(--warn, #ffc35c)' : 'var(--accent, #4f9cf9)';
    return `<div class="small" style="margin-top:6px">${esc(label)}: <b>${pct}%</b> used${w.resetsAt ? ` · resets ${esc(when(w.resetsAt))}` : ''}${w.resetSinceCheck ? ' (reset since last check)' : ''}
      <div style="height:6px;border-radius:4px;background:rgba(255,255,255,.08);margin-top:3px"><div style="height:6px;border-radius:4px;width:${Math.max(2, pct)}%;background:${col}"></div></div></div>`;
  };
  const win = (m) => (m === 300 ? '5-hour limit' : m === 10080 ? 'Weekly limit' : m ? `${Math.round(m / 60)}-hour limit` : 'Limit');
  const block = (key) => {
    const x = u[key];
    if (!x || !x.found) return `<div class="row"><b>${esc((x && x.label) || key)}</b><span class="muted">Not found on this computer</span></div>`;
    const w = x.windows;
    const l = x.limits;
    return `<div style="margin-bottom:10px"><div class="row"><b>${esc(x.label)}</b><span>${fmt(w.h5.total)} tokens in 5h · ${fmt(w.d1.total)} today · ${fmt(w.d7.total)} this week</span></div>
      ${l ? `${l.plan ? `<div class="small muted">Plan: ${esc(l.plan)}${l.limitReached ? ' · <b style="color:var(--warn)">limit reached</b>' : ''}</div>` : ''}${meter(win(l.primary && l.primary.windowMinutes), l.primary)}${meter(win(l.secondary && l.secondary.windowMinutes), l.secondary)}`
        : key === 'claude' ? '<div class="small muted">Claude does not write its quota percentage to disk; limit hits from Cortex runs show below.</div>' : ''}
      ${x.unreadable ? `<div class="small muted">${x.unreadable} compressed log(s) need Node 22.15+ to read.</div>` : ''}</div>`;
  };
  const notes = (u.notices || []).map((n) => `<div class="small" style="color:var(--warn)">⚠ ${esc(n.agent || n.tool || 'agent')}: ${esc(n.message)} (${esc(when(n.at))})</div>`).join('');
  return block('claude') + block('codex') + notes;
}

async function renderAgents() {
  try {
    const [ag, lv, cfg] = await Promise.all([api('/api/agents'), api('/api/live'), S.config ? Promise.resolve(S.config) : api('/api/config')]);
    S.config = cfg; HUB.data = ag; LIVE.sessions = lv.sessions; LIVE.approvals = lv.approvals || [];
  } catch (e) { return fail(e); }
  if (!HUB.usage || Date.now() - (HUB.usageAt || 0) > 60e3) {
    HUB.usageAt = Date.now();
    api('/api/usage').then((u) => { HUB.usage = u; const el = $('#account-usage'); if (el) el.innerHTML = accountUsageHtml(u); }).catch(() => {});
  }
  if (S.route[0] !== 'agents') return;
  const ag = HUB.data;
  const toolOpts = Object.entries(ag.available).map(([k, t]) => `<option value="${k}" ${t.installed ? '' : 'disabled'}>${esc(t.label)}${t.installed ? '' : ' (not found on this PC: see below)'}</option>`).join('');
  const seen = (ag.agents || []).filter((a) => !/^anthropic/i.test(a));
  const ready = ag.ready || {};
  const missing = Object.entries(ag.available).filter(([, t]) => !t.installed);
  const readyHtml = (!ready.folders || !ready.tool) ? `<div class="panel" style="padding:14px;margin-bottom:12px;border-color:rgba(255,195,92,.4)">
      <h3 style="color:var(--warn);margin-bottom:8px">Almost ready: ${[!ready.tool && 'install an agent', !ready.folders && 'pick a folder'].filter(Boolean).join(' and ')}</h3>
      ${!ready.tool ? missing.map(([k, t]) => `<div class="small" style="margin-bottom:10px"><b>${esc(t.label)} wasn't found on this PC.</b><br>${esc(t.help || '').replace(/ {2}(.+?) {2}/g, ' <code>$1</code> ')}
        ${ag.local ? `<div class="row" style="margin-top:6px"><input class="input" id="path-${k}" placeholder="Or paste where it's installed, e.g. ${k === 'claude' ? 'C:\\Users\\you\\.local\\bin\\claude.exe' : 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd'}" style="flex:1"><button class="btn sm" data-setpath="${k}">Use this</button></div>` : ''}</div>`).join('') + `<button class="btn sm" id="recheck">Check again</button>` : ''}
      ${!ready.folders ? `<div class="small" style="margin-top:8px"><b>Pick the folder(s) agents may work in.</b> They can only read and change files inside these.</div>
        ${ag.local ? `<div class="row" style="margin-top:6px;flex-wrap:wrap">${(ag.projectFolders || []).map((pf) => `<button class="btn sm" data-addfolder="${esc(pf.folder)}">+ ${esc(pf.title)}</button>`).join('')}<button class="btn sm" data-addfolder="${esc(ag.vault)}">+ My Cortex vault</button></div>
        <div class="row" style="margin-top:6px"><input class="input" id="add-folder" placeholder="C:\\Users\\you\\Desktop\\My Project" style="flex:1"><button class="btn sm primary" id="add-folder-btn">Add folder</button></div>` : '<span class="small muted">Add folders from the computer.</span>'}` : ''}
    </div>` : '';
  main.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Agent control</div><h1>Your <span class="grad">agents</span></h1><p>Send agents to work from here or your phone, keep every chat organised by project, and see exactly what each one did.</p></div></div>
    <div class="panel" style="margin-bottom:12px"><h3>AI usage</h3>
      <p class="small muted">Everything Claude Code and Codex used on this computer (including work outside Cortex), with the Codex plan quota. Desktop and web apps don't keep local logs, so they aren't counted.</p>
      <div id="account-usage">${accountUsageHtml(HUB.usage)}</div>
      <p class="small muted" style="margin-top:10px">Runs started from Cortex:</p>
      <div id="agent-usage">${agentUsageHtml()}</div>
    </div>
    <div class="hub-grid">
      <div class="panel">
        <div class="row" style="margin-bottom:14px"><div class="seg"><button data-hubtab="launch" class="${HUB.tab === 'launch' ? 'on' : ''}">${icon('i-bolt')} Start an agent</button><button data-hubtab="command" class="${HUB.tab === 'command' ? 'on' : ''}">${icon('i-send')} Send a command</button></div></div>
        ${HUB.tab === 'launch' ? (ag.enabled ? `${readyHtml}
          <form id="launch" class="modal-body" style="padding:0">
            <div class="grid2">
              <div class="field"><label>Agent</label><select class="input" name="tool" id="l-tool">${toolOpts}</select></div>
              <div class="field"><label>Model</label><input class="input" name="model" id="l-model" list="l-models" autocomplete="off" placeholder="Default"><datalist id="l-models"></datalist><span class="small muted" id="l-model-hint"></span></div>
              <div class="field"><label>Project</label><select class="input" name="project" id="l-proj">${projectOptions(store.get('lastProj', ''), 'No project (system memories only)')}</select></div>
              <div class="field"><label>Task (optional)</label><select class="input" name="task" id="l-task"></select></div>
              <div class="field"><label>Folder</label><select class="input" name="folder" id="l-folder">${ag.folders.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>
            </div>
            <div class="field"><label>What should it do?</label><textarea class="input" name="prompt" rows="4" placeholder="e.g. Fix the failing login test and explain what was wrong"></textarea></div>
            <div class="row" style="flex-wrap:wrap;gap:8px">${Object.entries(ag.available).filter(([, t]) => t.installed).map(([k, t]) => `<button type="button" class="btn sm" data-agcheck="${k}" title="${esc(t.path)}">Test ${esc(t.label)}</button>`).join('')}<span class="small muted" id="agcheck-out" style="flex:1"></span></div>
            <div class="row"><span class="small muted" style="flex:1">The agent gets a Cortex brief: your instructions, the project's memories and tasks, and the rules to save what it learns. Cortex records the result in the project's agent journal.</span><button type="button" class="btn ghost sm" id="l-brief">Preview brief</button><button class="btn primary">${icon('i-bolt')} Start</button></div>
          </form>` : `<div class="empty">Starting agents from Cortex is off.<br>${S.local ? '<button class="btn primary" data-go="settings" style="margin-top:10px">Turn it on in Settings</button>' : 'Turn it on in Settings on your computer.'}</div>`) : `
          <form id="cmd" class="modal-body" style="padding:0">
            <div class="grid2">
              <div class="field"><label>Send to</label><select class="input" name="target"><option value="any">Any agent</option><option value="claude">Claude (any Claude app or Claude Code)</option><option value="openai">ChatGPT / Codex</option><option value="cursor">Cursor</option>${seen.length ? `<optgroup label="A specific agent">${seen.map((a) => `<option>${esc(a)}</option>`).join('')}</optgroup>` : ''}</select></div>
              <div class="field"><label>Project</label><select class="input" name="project">${projectOptions('', 'No project')}</select></div>
            </div>
            <div class="field"><label>Instruction</label><textarea class="input" name="text" rows="3" placeholder="e.g. Summarise today's open tasks and flag anything blocked"></textarea></div>
            <div class="row"><span class="small muted" style="flex:1">A command waits until an agent checks in. Claude Code on this PC picks it up as soon as you start or message it; chat apps pick it up the next time you talk to them. To start work <b>right now</b>, use <b>Run now</b> on the command (or the Start an agent tab).</span><button class="btn primary">${icon('i-send')} Send</button></div>
          </form>`}
      </div>
      <div class="panel"><h3>${icon('i-send')} Commands</h3><div class="list" style="gap:8px;max-height:330px;overflow:auto">
        ${ag.commands.slice(0, 20).map((c) => `<div class="cmd"><div><b>${esc(c.text.slice(0, 140))}</b><div class="small muted">to ${esc(c.target === 'any' ? 'any agent' : c.target)}${c.takenBy ? ` · taken by ${esc(c.takenBy)}` : ''} · ${timeAgo(c.ts)}</div></div>
          <div class="row" style="gap:6px">${c.status === 'pending' && ag.enabled && ready.tool && ready.folders ? `<button class="btn sm primary" data-cmd-run="${esc(c.id)}" title="Start Claude Code on this PC to do it now">${icon('i-bolt')} Run now</button>` : ''}<span class="spill ${c.status === 'done' ? 'done' : c.status === 'failed' ? 'error' : c.status === 'taken' ? 'working' : ''}">${esc(c.status === 'pending' ? 'waiting for an agent' : c.status)}</span><button class="btn ghost sm" data-cmd-del="${esc(c.id)}" title="Remove">${icon('i-x')}</button></div>
          ${c.result ? `<div class="res">${esc(c.result)}</div>` : ''}</div>`).join('') || '<div class="empty">No commands yet.</div>'}
      </div></div>
    </div>
    <div class="panel">
      <h3>${icon('i-chat')} Chats &amp; sessions <span class="small muted" style="text-transform:none;letter-spacing:0;font-weight:400">every agent conversation, organised</span></h3>
      <div class="board-bar">
        <input class="input" id="h-q" placeholder="Search chats…" value="${esc(HUB.filter.q)}" style="max-width:240px">
        <select class="input" id="h-proj">${projectOptions(HUB.filter.project, 'All projects')}</select>
        <select class="input" id="h-agent"><option value="">All agents</option>${seen.map((a) => `<option ${a === HUB.filter.agent ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
        <div class="seg">${['active', 'all', 'archived'].map((k) => `<button data-hstat="${k}" class="${HUB.filter.status === k ? 'on' : ''}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      </div>
      <div class="hub"><div class="hub-list" id="hub-list"></div><div class="chat-detail" id="hub-detail"></div></div>
    </div>
    <details class="panel" style="margin-top:18px" ${LIVE.sessions.length ? '' : 'open'}>
      <summary style="cursor:pointer;font-weight:650">${icon('i-plug')} Connect an agent to Cortex</summary>
      <div style="margin-top:14px">${connectHtml(S.config)}</div>
    </details>`;
  bindConnect(S.config);
  const saveAgents = async (body, okMsg) => { try { await api('/api/settings', { method: 'POST', body: { agents: body } }); toast(okMsg); renderAgents(); } catch (e) { fail(e); } };
  $$('[data-addfolder]').forEach((b) => (b.onclick = () => saveAgents({ addFolder: b.dataset.addfolder }, 'Folder allowed')));
  const af = $('#add-folder-btn');
  if (af) af.onclick = () => saveAgents({ addFolder: $('#add-folder').value }, 'Folder allowed');
  $$('[data-setpath]').forEach((b) => (b.onclick = () => saveAgents({ [b.dataset.setpath + 'Path']: $('#path-' + b.dataset.setpath).value }, 'Saved')));
  const rc = $('#recheck');
  if (rc) rc.onclick = () => { toast('Checking…'); renderAgents(); };
  $$('[data-agcheck]').forEach((b) => (b.onclick = async () => {
    const out = $('#agcheck-out');
    b.disabled = true; out.textContent = 'Testing… (starts it and checks sign-in, up to a minute)';
    try {
      const r = await api('/api/agents/check', { method: 'POST', body: { tool: b.dataset.agcheck } });
      out.innerHTML = `<span class="chip ${r.signedIn ? 'ok' : 'warn'}">${r.signedIn ? '✓ ready' : r.found ? 'needs attention' : 'not found'}</span> ${esc(r.version || '')} · ${esc(r.detail)}<br><code>${esc(r.path || '')}</code>`;
    } catch (e) { out.textContent = e.message; }
    b.disabled = false;
  }));
  $$('[data-cmd-run]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const r = await api('/api/commands/run', { method: 'POST', body: { id: b.dataset.cmdRun } }); toast('Claude Code started on it: follow it below'); HUB.sel = r.id; store.set('hubSel', r.id); HUB.filter.status = 'active'; store.set('hubFilter', HUB.filter); renderAgents(); } catch (e) { fail(e); b.disabled = false; }
  }));
  $$('[data-hubtab]').forEach((b) => (b.onclick = () => { HUB.tab = b.dataset.hubtab; store.set('hubTab', HUB.tab); renderAgents(); }));
  const lp = $('#l-proj');
  if (lp) {
    const fillTasks = () => { const p = lp.value; $('#l-task').innerHTML = '<option value="">No specific task</option>' + S.tasks.filter((t) => t.status !== 'done' && (!p || t.project === p)).map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join(''); const pr = proj(p); if (pr && pr.folder) { const f = $('#l-folder'); if (![...f.options].some((o) => o.value === pr.folder)) f.insertAdjacentHTML('afterbegin', `<option>${esc(pr.folder)}</option>`); f.value = pr.folder; } };
    // Model: suggestions for the chosen agent; the project's default model fills the placeholder.
    const fillModel = (fromProject) => {
      const pr = proj(lp.value);
      const tsel = $('#l-tool');
      if (fromProject && pr && pr.agent_tool && [...tsel.options].some((o) => o.value === pr.agent_tool && !o.disabled)) tsel.value = pr.agent_tool;
      const tool = tsel.value;
      $('#l-models').innerHTML = (AGENT_MODELS[tool] || []).map((mm) => `<option value="${esc(mm)}">`).join('');
      const def = pr && pr.agent_model && (pr.agent_tool || 'claude') === tool ? pr.agent_model : '';
      $('#l-model').placeholder = def ? `Project default: ${def}` : 'Default';
      $('#l-model-hint').textContent = tool === 'claude' ? 'opus, sonnet, haiku or a full model name' : 'a Codex model name, or leave empty for your Codex default';
    };
    $('#l-tool').onchange = () => fillModel(false);
    lp.onchange = () => { store.set('lastProj', lp.value); fillTasks(); fillModel(true); };
    fillTasks();
    fillModel(true);
    if (HUB.pendingTask) { $('#l-task').value = HUB.pendingTask; HUB.pendingTask = ''; }
    $('#l-brief').onclick = async () => {
      const f = $('#launch');
      const q = new URLSearchParams({ project: f.project.value, task: f.task.value, assignment: f.prompt.value });
      const b = await api('/api/brief?' + q).catch(fail);
      if (b) modal(`<div class="modal-head"><h2>What the agent will receive</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div><div class="modal-body"><div class="prose" style="padding:0">${md(b.text)}</div></div>`, (r) => r.querySelector('.modal').classList.add('wide'));
    };
    $('#launch').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await api('/api/agents/run', { method: 'POST', body: { tool: f.tool.value, model: f.model.value.trim() || undefined, project: f.project.value || undefined, task: f.task.value || undefined, folder: f.folder.value || undefined, prompt: f.prompt.value } });
        toast('Agent started: follow it live below');
        HUB.sel = r.id; store.set('hubSel', r.id); HUB.filter.status = 'active'; store.set('hubFilter', HUB.filter);
        renderAgents();
      } catch (er) { fail(er); }
    };
  }
  const cf = $('#cmd');
  if (cf) cf.onsubmit = async (e) => { e.preventDefault(); try { await api('/api/commands', { method: 'POST', body: { text: cf.text.value, target: cf.target.value, project: cf.project.value || undefined } }); toast('Command queued'); renderAgents(); } catch (er) { fail(er); } };
  const setF = (k, v) => { HUB.filter[k] = v; store.set('hubFilter', HUB.filter); renderHubList(); };
  $('#h-q').oninput = (e) => setF('q', e.target.value);
  $('#h-proj').onchange = (e) => setF('project', e.target.value);
  $('#h-agent').onchange = (e) => setF('agent', e.target.value);
  $$('[data-hstat]').forEach((b) => (b.onclick = () => { $$('[data-hstat]').forEach((x) => x.classList.toggle('on', x === b)); setF('status', b.dataset.hstat); }));
  renderHubList();
}
function hubChats() {
  const f = HUB.filter;
  const q = f.q.toLowerCase();
  return LIVE.sessions.filter((x) => (f.status === 'all' ? !x.archived : f.status === 'archived' ? x.archived : !x.archived && (chatStatus(x) === 'active' || Date.now() - new Date(x.updated).getTime() < 36e5 * 24))
    && (!f.project || x.project === f.project) && (!f.agent || x.agent === f.agent) && (!q || `${x.title} ${x.agent} ${x.workspace} ${(x.tags || []).join(' ')}`.toLowerCase().includes(q)))
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || (a.updated < b.updated ? 1 : -1));
}
function renderHubList() {
  const el = $('#hub-list');
  if (!el) return;
  const list = hubChats();
  if (!HUB.sel || !list.some((x) => x.id === HUB.sel)) HUB.sel = list[0] ? list[0].id : '';
  el.innerHTML = list.map((x) => `<div class="chat-row ${x.id === HUB.sel ? 'on' : ''}" data-chat="${esc(x.id)}">${avatar(x.agent)}<div style="min-width:0"><div class="ttl">${x.pinned ? '📌 ' : ''}${esc(x.title || x.agent)}</div><div class="sub">${esc(x.agent)}${x.project ? ' · ' + esc(proj(x.project)?.title || x.project) : ''} · ${timeAgo(x.updated)}</div></div><span class="spill ${esc(x.status)}">${esc(STATUS_TEXT[x.status] || x.status)}</span></div>`).join('') || '<div class="empty">No chats match.</div>';
  $$('[data-chat]', el).forEach((r) => (r.onclick = () => { HUB.sel = r.dataset.chat; store.set('hubSel', HUB.sel); renderHubList(); }));
  renderHubDetail();
}
function renderHubDetail() {
  const el = $('#hub-detail');
  if (!el) return;
  const x = LIVE.sessions.find((s) => s.id === HUB.sel);
  if (!x) { el.innerHTML = '<div class="empty">Select a chat to see everything the agent did.</div>'; return; }
  const running = (HUB.data && HUB.data.running.includes(x.id));
  const t = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="row" style="align-items:flex-start">${avatar(x.agent)}<div style="flex:1;min-width:0"><input class="ed-title" id="c-title" value="${esc(x.title || '')}" style="font-size:20px" placeholder="Name this chat"><div class="small muted">${esc(x.agent)}${x.workspace ? ' · ' + esc(x.workspace) : ''} · started ${timeAgo(x.started)}${x.model ? ' · ' + esc(x.model) : ''}</div></div><span class="spill ${esc(x.status)}">${esc(STATUS_TEXT[x.status] || x.status)}</span></div>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <select class="input" id="c-proj" style="width:auto">${projectOptions(x.project, 'No project')}</select>
      <input class="input" id="c-tags" placeholder="tags" value="${esc((x.tags || []).join(', '))}" style="width:180px">
      <button class="btn sm" id="c-pin">${x.pinned ? 'Unpin' : 'Pin'}</button>
      <button class="btn sm" id="c-arch">${x.archived ? 'Unarchive' : 'Archive'}</button>
      ${running ? '<button class="btn sm danger" id="c-stop">■ Stop agent</button>' : ''}
      ${x.task ? `<button class="btn sm ghost" data-task="${esc(x.task)}">Open task</button>` : ''}
    </div>
    ${x.step ? `<div class="lc-step">${x.status === 'working' ? '<span class="spinner"></span>' : ''}<span>${esc(x.step)}</span></div>` : ''}
    ${x.result ? `<div class="panel" style="padding:14px"><h3 style="margin-bottom:8px">Outcome</h3><div class="prose" style="padding:0">${md(x.result)}</div></div>` : ''}
    <div class="timeline">${(x.events || []).slice().reverse().map((e) => `<div class="tl k-${esc(e.kind)}"><span class="tm">${t(e.ts)}</span>${esc(e.text)}</div>`).join('') || '<span class="muted small">No activity yet.</span>'}</div>
    ${x.claude_session && !running ? `<form class="lc-msg" id="c-cont"><input class="input" name="p" placeholder="Continue this chat: give a follow-up instruction…"><button class="btn primary sm">Continue</button></form>` : `<form class="lc-msg" id="c-msg"><input class="input" name="p" placeholder="Message ${esc(x.agent)}…"><button class="btn primary sm">Send</button></form>`}`;
  const save = (body) => api('/api/live', { method: 'PATCH', body: { id: x.id, ...body } }).then(() => updateLive()).catch(fail);
  $('#c-title').onchange = (e) => save({ title: e.target.value });
  $('#c-proj').onchange = (e) => save({ project: e.target.value || null });
  $('#c-tags').onchange = (e) => save({ tags: e.target.value });
  $('#c-pin').onclick = () => save({ pinned: !x.pinned });
  $('#c-arch').onclick = () => save({ archived: !x.archived });
  if ($('#c-stop')) $('#c-stop').onclick = () => api('/api/agents/stop', { method: 'POST', body: { id: x.id } }).then(() => toast('Stopping…')).catch(fail);
  const cont = $('#c-cont');
  if (cont) cont.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/agents/run', { method: 'POST', body: { prompt: cont.p.value, resumeFrom: x.id } }); HUB.sel = r.id; store.set('hubSel', r.id); renderAgents(); } catch (er) { fail(er); } };
  const msg = $('#c-msg');
  if (msg) msg.onsubmit = async (e) => { e.preventDefault(); if (!msg.p.value.trim()) return; try { await api('/api/live/message', { method: 'POST', body: { session: x.id, text: msg.p.value } }); msg.p.value = ''; toast('Sent: delivered at the agent\'s next step'); updateLive(); } catch (er) { fail(er); } };
}
function connectHtml(cfg) {
  return `
    <div class="field" style="margin-bottom:14px"><label>Prompt for your AI agents: paste into CLAUDE.md, ChatGPT custom instructions or project instructions</label>
      <div class="code"><pre class="wrap" id="agent-prompt">${esc(cfg.agentPrompt)}</pre><button class="btn sm copy" data-copy-prompt>${icon('i-copy')}</button></div></div>
    <p class="small muted" style="margin-top:-4px">MCP endpoint: <code>${esc(cfg.url)}</code> · Vault: <code>${esc(cfg.vault)}</code></p>
    ${cfg.items.map((it, i) => `
      <details class="conn" ${i === 0 ? 'open' : ''}><summary>${esc(it.name)} ${it.verified === true ? '<span class="chip ok">checked against docs</span>' : it.verified === false ? '<span class="chip warn">not verified yet</span>' : ''}<span class="muted">${esc(it.where)}</span></summary>
        <div class="body">
          <div class="code"><pre>${esc(it.code)}</pre><button class="btn sm copy" data-copy="${i}:code">${icon('i-copy')}</button></div>
          ${it.alt ? `<div class="small muted">${esc(it.altLabel)}</div><div class="code"><pre>${esc(it.alt)}</pre><button class="btn sm copy" data-copy="${i}:alt">${icon('i-copy')}</button></div>` : ''}
        </div></details>`).join('')}
    <p class="small muted">Easiest on this computer: run <code>node bin/cortex.js setup</code> (or double-click Setup Cortex). It connects every AI app it finds for you. JSON blocks go into the named config <b>file</b>, not into a terminal.</p>`;
}
function bindConnect(cfg) {
  $$('[data-copy]').forEach((b) => (b.onclick = () => { const [i, k] = b.dataset.copy.split(':'); copy(cfg.items[i][k]); }));
  $$('[data-copy-prompt]').forEach((b) => (b.onclick = () => copy(cfg.agentPrompt)));
}

// ---------- MIND ----------
const MIND_SECTIONS = [['watch', 'Watch', 'i-play', 'Videos for the AI to watch (via transcript)'], ['read', 'Read', 'i-book', 'Articles and pages to read'], ['write', 'Write', 'i-pen', 'Articles you want written']];
function ytThumb(url) { try { const u = new URL(url); const id = u.hostname.includes('youtu.be') ? u.pathname.slice(1, 12) : u.searchParams.get('v') || (u.pathname.match(/\/(shorts|embed|live)\/([\w-]{11})/) || [])[2]; return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''; } catch { return ''; } }
function renderMind() {
  const items = S.mind || [];
  main.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Mind</div><h1>Feed your <span class="grad">second brain</span></h1><p>Drop in videos and articles for your agents to absorb, or topics you want written. Agents fetch the transcript or text, summarise it, and the summary becomes a linked memory.</p></div></div>
    <form class="mind-add glass" id="mind-add">
      <input class="input" name="v" placeholder="Paste a video or article link, or type a topic to write about…" autocomplete="off">
      <select class="input" name="section" style="width:auto"><option value="">Auto</option><option value="watch">Watch</option><option value="read">Read</option><option value="write">Write</option></select>
      <button class="btn primary">${icon('i-plus')} Add</button>
    </form>
    <div class="mind-cols">
      ${MIND_SECTIONS.map(([k, label, ic, desc]) => {
        const list = items.filter((m) => m.section === k);
        return `<div class="mind-col"><h2><span class="orb">${icon(ic)}</span>${label}<span class="n">${list.filter((m) => m.status !== 'done').length} waiting · ${list.filter((m) => m.status === 'done').length} done</span></h2>
          ${list.map((m) => mindCard(m)).join('') || `<div class="empty">${desc}</div>`}</div>`;
      }).join('')}
    </div>`;
  $('#mind-add').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = f.v.value.trim();
    if (!v) return;
    const isUrl = /^https?:\/\//i.test(v);
    try {
      const r = await api('/api/mind', { method: 'POST', body: isUrl ? { url: v, section: f.section.value || undefined, fetch: true } : { title: v, section: 'write' } });
      toast(r.duplicate ? 'Already in Mind' : isUrl ? 'Added: fetching it now' : 'Added to Write');
      f.v.value = '';
      setTimeout(refresh, 400);
    } catch (er) { fail(er); }
  };
}
function mindCard(m) {
  const thumb = m.section === 'watch' && m.url ? ytThumb(m.url) : '';
  let host = '';
  try { host = m.url ? new URL(m.url).hostname.replace(/^www\./, '') : ''; } catch { /* */ }
  return `<div class="mcard glass" data-mind="${esc(m.id)}">
    ${thumb ? `<div class="thumb" style="background-image:url('${esc(thumb)}')"></div>` : ''}
    <div class="mt">${esc(m.title)}</div>
    <div class="mm"><span class="mstat ${esc(m.status)}">${esc(m.status)}</span>${host ? `<span>${esc(host)}</span>` : ''}${m.channel ? `<span>· ${esc(m.channel)}</span>` : ''}<span style="margin-left:auto">${timeAgo(m.updated)}</span></div>
    ${m.fetch_note && m.status !== 'done' ? `<div class="small muted">${esc(m.fetch_note)}</div>` : ''}
    <div class="acts">
      ${m.section !== 'write' && m.status !== 'done' ? `<button class="btn sm" data-mfetch="${esc(m.id)}">${m.status === 'fetched' ? 'Re-fetch' : 'Fetch now'}</button>` : ''}
      ${m.status !== 'done' ? `<button class="btn sm primary" data-mproc="${esc(m.id)}">${m.section === 'write' ? 'Ask an agent to write' : 'Ask an agent to summarise'}</button>` : ''}
      ${m.url ? `<a class="btn sm ghost" href="${esc(m.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
    </div></div>`;
}
async function openMind(id) {
  const m = await api('/api/item?id=' + encodeURIComponent(id)).catch(fail);
  if (!m) return;
  modal(`<div class="modal-head"><h2>${esc(m.title)}</h2><span class="mstat ${esc(m.status)}">${esc(m.status)}</span><button class="btn ghost sm" data-close>${icon('i-x')}</button></div>
    <div class="modal-body">
      ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="small">${esc(m.url)}</a>` : ''}
      <div class="field"><label>Notes / instructions for the agent</label><textarea class="input" id="mi-notes" rows="2">${esc(m.notes || '')}</textarea></div>
      ${m.memory ? `<button class="btn sm" data-open="${esc(m.memory)}">Open the memory note →</button>` : ''}
      <div class="prose" style="padding:0;max-height:52vh;overflow:auto">${md(m.body) || '<span class="muted">Nothing fetched yet.</span>'}</div>
    </div>
    <div class="modal-foot"><button class="btn danger" id="mi-del">${icon('i-trash')} Delete</button><span class="spacer"></span><button class="btn" data-close>Close</button><button class="btn primary" id="mi-save">Save notes</button></div>`,
  (root) => {
    root.querySelector('.modal').classList.add('wide');
    $('#mi-save', root).onclick = () => api('/api/items', { method: 'PATCH', body: { id: m.id, notes: $('#mi-notes', root).value, quiet: true } }).then(() => { closeModal(); refresh(); }).catch(fail);
    $('#mi-del', root).onclick = async () => { if (!confirm('Delete this Mind item?')) return; await api('/api/items?id=' + encodeURIComponent(m.id), { method: 'DELETE' }).catch(fail); closeModal(); refresh(); };
  });
}
async function processMind(id) {
  const launch = HUB.data ? HUB.data.enabled : (await api('/api/agents').catch(() => ({}))).enabled;
  try {
    const r = await api('/api/mind/process', { method: 'POST', body: { id, via: launch ? 'launch' : 'command' } });
    toast(r.id ? 'An agent is on it: follow it in Agents' : 'Queued for your next connected agent');
    refresh();
  } catch (e) { fail(e); }
}

// ---------- SKILLS ----------
async function renderSkills() {
  let list;
  try { list = await api('/api/skills'); } catch (e) { return fail(e); }
  if (S.route[0] !== 'skills') return;
  const label = { installed: ['ok', 'Added by Cortex'], outdated: ['warn', 'Update available'], yours: ['ok', 'Your own skill'], 'not installed': ['', 'Not added'] };
  main.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Skills library</div><h1>Teach your agents <span class="grad">skills</span></h1><p>Write a skill once and give it to Claude Code, Codex, Claude.ai and ChatGPT. Cortex only ever <b>adds</b> skills: skills you already have are never changed or removed. Every connected agent can also look skills up here with <code>skill_list</code>.</p></div>
      <div class="actions">${S.local ? `<button class="btn" id="sk-import">Import my Claude Code skills</button>` : ''}<button class="btn primary" id="sk-new">${icon('i-plus')} New skill</button></div></div>
    <div class="skills-grid">
      ${list.map((k) => `<div class="skill glass">
        <h4>${icon('i-skills')} ${esc(k.title)} <code>${esc(k.slug)}</code>${k.reference ? '<span class="chip">reference copy</span>' : ''}</h4>
        <p>${esc(k.description || 'No description yet: agents use the description to decide when to use a skill.')}</p>
        <div class="targets">
          ${k.installed ? Object.entries(k.installed).map(([t, st]) => `<div class="target"><b>${t === 'claude-code' ? 'Claude Code' : 'Codex'}</b><span class="chip ${label[st][0]}">${label[st][1]}</span>
            ${st === 'not installed' ? `<button class="btn sm" data-sk-add="${esc(k.id)}" data-t="${t}">Add</button>` : st === 'outdated' ? `<button class="btn sm" data-sk-add="${esc(k.id)}" data-t="${t}">Update</button>` : st === 'installed' ? `<button class="btn sm ghost" data-sk-rm="${esc(k.id)}" data-t="${t}">Remove</button>` : ''}</div>`).join('') : ''}
          <div class="target"><b>Claude.ai</b><a class="btn sm" href="/api/skills/zip?id=${encodeURIComponent(k.id)}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}" download>Download .zip</a></div>
          <div class="target"><b>ChatGPT</b><button class="btn sm" data-sk-gpt="${esc(k.id)}">Copy instructions</button></div>
        </div>
        <div class="row"><button class="btn sm ghost" data-sk-edit="${esc(k.id)}">Edit</button><span class="small muted" style="margin-left:auto">${k.source ? 'from ' + esc(k.source) + ' · ' : ''}${timeAgo(k.updated)}</span></div>
      </div>`).join('') || '<div class="empty">No skills yet.</div>'}
    </div>
    <div class="panel" style="margin-top:18px"><h3>How to add skills to each app</h3>
      <ul class="small" style="line-height:1.9;margin:0;padding-left:18px">
        <li><b>Claude Code / Codex</b>: click Add. Cortex writes <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> and marks it as Cortex's, so it never touches skills you made yourself.</li>
        <li><b>Claude.ai</b>: Download .zip, then in Claude go to <b>Customize → Skills → + → Create skill → Upload a skill</b>. Needs code execution turned on.</li>
        <li><b>ChatGPT</b>: Copy instructions and paste them into a Project's instructions or a custom GPT. If ChatGPT is connected to Cortex, it can also read any skill with <code>skill_get</code>.</li>
      </ul></div>`;
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('sk-new', () => skillModal());
  on('sk-import', async () => { try { const r = await api('/api/skills/import', { method: 'POST', body: { target: 'claude-code' } }); toast(`Imported ${r.imported.length} skill${r.imported.length === 1 ? '' : 's'} as references`); renderSkills(); } catch (e) { fail(e); } });
  $$('[data-sk-add]').forEach((b) => (b.onclick = () => api('/api/skills/install', { method: 'POST', body: { id: b.dataset.skAdd, target: b.dataset.t } }).then(() => { toast('Skill added'); renderSkills(); }).catch(fail)));
  $$('[data-sk-rm]').forEach((b) => (b.onclick = () => { if (confirm('Remove this Cortex-added skill from the app? (Only skills Cortex added can be removed.)')) api('/api/skills/install', { method: 'POST', body: { id: b.dataset.skRm, target: b.dataset.t, action: 'uninstall' } }).then(() => renderSkills()).catch(fail); }));
  $$('[data-sk-gpt]').forEach((b) => (b.onclick = () => api('/api/skills/chatgpt?id=' + encodeURIComponent(b.dataset.skGpt)).then((r) => copy(r.text)).catch(fail)));
  $$('[data-sk-edit]').forEach((b) => (b.onclick = () => skillModal(list.find((k) => k.id === b.dataset.skEdit))));
}
function skillModal(k) {
  modal(`<div class="modal-head"><h2>${k ? 'Edit skill' : 'New skill'}</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div>
    <div class="modal-body">
      <input class="input title-in" id="sk-t" placeholder="Skill name, e.g. Release notes" value="${esc(k ? k.title : '')}">
      <div class="field"><label>When should agents use it? (max 200 characters for Claude.ai)</label><input class="input" id="sk-d" maxlength="1024" value="${esc(k ? k.description || '' : '')}" placeholder="e.g. Use when writing release notes from git history"></div>
      <div class="field"><label>Instructions (Markdown)</label><textarea class="input" id="sk-b" rows="12" style="font-family:var(--mono);font-size:13px" placeholder="Step-by-step instructions, rules, examples…">${esc(k ? k.body || '' : '')}</textarea></div>
    </div>
    <div class="modal-foot">${k ? `<button class="btn danger" id="sk-del">${icon('i-trash')} Delete from Cortex</button>` : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="sk-save">Save</button></div>`,
  (root) => {
    $('#sk-save', root).onclick = async () => {
      const body = { title: $('#sk-t', root).value, description: $('#sk-d', root).value, body: $('#sk-b', root).value };
      try { if (k) await api('/api/items', { method: 'PATCH', body: { id: k.id, ...body } }); else await api('/api/items', { method: 'POST', body: { kind: 'skill', ...body } }); closeModal(); renderSkills(); } catch (e) { fail(e); }
    };
    if (k) $('#sk-del', root).onclick = async () => { if (!confirm('Delete this skill from Cortex? Copies already added to apps stay where they are.')) return; await api('/api/items?id=' + encodeURIComponent(k.id), { method: 'DELETE' }).catch(fail); closeModal(); renderSkills(); };
  });
}

// ---------- history (version restore) ----------
async function historyModal(id) {
  const vers = await api('/api/history?id=' + encodeURIComponent(id)).catch(fail);
  if (!vers) return;
  modal(`<div class="modal-head"><h2>Version history</h2><button class="btn ghost sm" data-close>${icon('i-x')}</button></div>
    <div class="modal-body"><p class="small muted" style="margin:0">Cortex keeps the last 30 versions of every note, task and project. Pick one to preview and restore.</p>
      <div class="row" style="align-items:flex-start;gap:14px"><div class="list" style="width:220px;max-height:50vh;overflow:auto" id="h-list">${vers.map((v) => `<div class="li" data-ver="${esc(v.version)}"><span class="t">${esc(v.version.replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2:$3'))}</span></div>`).join('') || '<div class="empty">No earlier versions yet.</div>'}</div>
      <div class="prose" id="h-prev" style="flex:1;padding:0;max-height:50vh;overflow:auto"></div></div></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" data-close>Close</button><button class="btn primary" id="h-restore" disabled>Restore this version</button></div>`,
  (root) => {
    root.querySelector('.modal').classList.add('wide');
    let sel = null;
    $$('[data-ver]', root).forEach((li) => (li.onclick = async () => {
      sel = li.dataset.ver;
      $$('[data-ver]', root).forEach((x) => x.classList.toggle('on', x === li));
      const r = await api(`/api/history?id=${encodeURIComponent(id)}&version=${encodeURIComponent(sel)}`).catch(fail);
      $('#h-prev', root).innerHTML = r ? md(r.text.replace(/^---[\s\S]*?---\s*/, '')) : '';
      $('#h-restore', root).disabled = false;
    }));
    $('#h-restore', root).onclick = async () => { try { await api('/api/history/restore', { method: 'POST', body: { id, version: sel } }); closeModal(); toast('Restored'); ED.dirty = false; loadEditor(id); refresh(); } catch (e) { fail(e); } };
  });
}

// ---------- LIVE ----------
const LIVE = { sessions: [], screenEnabled: false, drafts: {}, open: {}, screenOn: store.get('screenOn', true), timer: null, lastUrl: null, rendered: null };
const STATUS_TEXT = { working: 'Working', waiting: 'Waiting for you', 'needs-you': 'Needs you', done: 'Done', error: 'Error' };
async function fetchLive() {
  const d = await api('/api/live');
  LIVE.sessions = d.sessions;
  LIVE.approvals = d.approvals || [];
  LIVE.screenEnabled = d.screenEnabled;
  S.liveCount = d.sessions.filter((x) => ['working', 'needs-you'].includes(x.status)).length;
}
let liveTimer = null;
function updateLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    try { await fetchLive(); } catch { return; }
    renderNav();
    if (S.route[0] === 'agents') {
      const usage = $('#agent-usage');
      if (usage) usage.innerHTML = agentUsageHtml();
      renderHubList();
      return;
    }
    if (S.route[0] === 'home') { const n = $('#approvals'); if (n) n.innerHTML = approvalsHtml(); return; }
    if (S.route[0] !== 'live') return;
    if (LIVE.rendered !== LIVE.screenEnabled) renderLive(true); else { renderSessions(); const ap = $('#approvals'); if (ap) ap.innerHTML = approvalsHtml(); }
  }, 250);
}
async function renderLive(skipFetch) {
  if (!skipFetch) { try { await fetchLive(); } catch (e) { return fail(e); } renderNav(); }
  if (S.route[0] !== 'live') return;
  LIVE.rendered = LIVE.screenEnabled;
  main.innerHTML = `
    <div class="page-head"><div><h1>Live</h1><p>Watch your computer and your agents work, and message them, from here or your phone.</p></div>
      ${S.local ? `<div class="actions"><button class="btn" data-go="settings">${icon('i-phone')} Connect your phone</button></div>` : ''}</div>
    <div id="approvals">${approvalsHtml()}</div>
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
function approvalsHtml() {
  const list = LIVE.approvals || [];
  if (!list.length) return '';
  return `<div class="panel" style="border-color:rgba(255,195,92,.45);box-shadow:0 0 30px rgba(255,195,92,.15);margin-bottom:18px"><h3 style="color:var(--warn)">🔐 Waiting for your approval</h3>
    ${list.map((a) => `<div class="cmd" style="margin-bottom:8px"><div><b>${esc(a.summary)}</b><div class="small muted">${esc(a.tool)} · ${esc(a.cwd || '')} · ${timeAgo(a.ts)}</div></div>
      <div class="row" style="gap:6px"><button class="btn sm danger" data-approve="${esc(a.id)}" data-d="deny">Deny</button><button class="btn sm primary" data-approve="${esc(a.id)}" data-d="allow">Allow</button></div>
      <div class="res"><details><summary class="small">Details</summary><pre style="white-space:pre-wrap;font:12px var(--mono)">${esc(a.input)}</pre></details></div></div>`).join('')}</div>`;
}
function sessionCard(x) {
  const ev = (x.events || []).slice().reverse();
  const t = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const snapUrl = x.snapshot ? `/api/live/snap?id=${encodeURIComponent(x.id)}&t=${encodeURIComponent(x.snapshot.ts)}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}` : '';
  return `<div class="lcard s-${esc(x.status)}">
    <div class="lc-head">${avatar(x.agent)}<div class="lc-who"><b>${esc(x.agent)}</b><span class="small muted">${x.workspace ? esc(x.workspace) + ' · ' : ''}${timeAgo(x.updated)}</span></div>
      <span class="spill ${esc(x.status)}">${esc(STATUS_TEXT[x.status] || x.status)}</span>${x.launched && x.status === 'working' ? `<button class="btn sm danger" data-stop-run="${esc(x.id)}" title="Stop this agent">■</button>` : ''}<button class="btn ghost sm" data-live-del="${esc(x.id)}" title="Dismiss">${icon('i-x')}</button></div>
    ${x.project ? `<div><span class="chip"><span class="pdot" style="background:${projColor(x.project)}"></span>${esc(proj(x.project)?.title || x.project)}</span></div>` : ''}
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
// Public link chooser: permanent (Tailscale Funnel) vs quick (Cloudflare, changes on every restart).
function publicLinkHtml(st, { compact = false } = {}) {
  const c = st.connector, tn = c.tunnel || {};
  const ts = c.provider === 'tailscale';
  const status = tn.running && tn.url
    ? `<span class="chip ok">${ts ? '✓ Permanent link on' : 'Quick link on'}</span>`
    : tn.starting ? '<span class="chip">Starting…</span>' : '<span class="chip">Off</span>';
  const warn = !ts && tn.url ? `<p class="small" style="color:var(--warn,#f5b84a);margin:6px 0 0">This quick link changes every time Cortex restarts or updates, and saved connectors then stop working. Switch to the permanent link to fix that for good.</p>` : '';
  const err = tn.error ? `<p class="small" style="color:var(--bad);margin:6px 0 0">${esc(tn.error)}</p>` : '';
  const enable = tn.enableUrl ? `<p class="small" style="margin:6px 0 0"><a class="btn sm primary" href="${esc(tn.enableUrl)}" target="_blank" rel="noopener">Turn on Funnel in Tailscale ↗</a> then <button class="btn sm" data-tunnel="check">Check again</button></p>` : '';
  const tsBtn = c.tailscale
    ? `<button class="btn sm ${ts ? '' : 'primary'}" data-tunnel="start" data-provider="tailscale">${ts && tn.running ? 'Re-check permanent link' : 'Use permanent link (Tailscale)'}</button>`
    : `<a class="btn sm" href="https://tailscale.com/download" target="_blank" rel="noopener">Install Tailscale for a permanent link ↗</a>`;
  const cfBtn = c.cloudflared
    ? `<button class="btn sm ghost" data-tunnel="start" data-provider="cloudflare">${!ts && tn.running ? 'Restart quick link' : 'Use quick link (Cloudflare)'}</button>`
    : '';
  const off = tn.running ? '<button class="btn sm ghost" data-tunnel="stop">Turn off</button>' : '';
  return `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:${compact ? 6 : 0}px">${status}${tsBtn}${cfBtn}${off}</div>${warn}${err}${enable}`;
}
// ---------- "Link Claude & ChatGPT" guided panel ----------
function linkAppsHtml(st, c) {
  const tn = st.connector.tunnel;
  const url = tn.url ? `${tn.url}/mcp/${st.connector.token}` : '';
  const ins = st.instructions || {};
  const done = (ok) => `<span class="chip ${ok ? 'ok' : ''}">${ok ? '✓ done' : 'to do'}</span>`;
  const linkStep = (url
    ? `<div class="code"><pre class="wrap" style="font-size:11px">${esc(url)}</pre><button class="btn sm copy" data-copy-text="${esc(url)}">${icon('i-copy')}</button></div>`
    : '') + publicLinkHtml(st, { compact: !!url });
  const step = (n, title, body) => `<div class="row" style="align-items:flex-start;gap:12px;margin:10px 0"><span class="av" style="background:var(--aurora);width:26px;height:26px;border-radius:8px;font-size:12px;flex:none">${n}</span><div style="flex:1;min-width:0"><b>${title}</b><div class="small muted" style="margin-top:3px">${body}</div></div></div>`;
  const card = (name, sub, connectorHtml, instrHtml) => `<div class="panel" style="flex:1;min-width:300px"><h3>${name} <span class="small muted" style="text-transform:none;letter-spacing:0;font-weight:400">${sub}</span></h3>${connectorHtml}${instrHtml}</div>`;
  const pc = ins['claude-code'] === 'installed' || ins.codex === 'installed';
  return `<div class="panel" style="margin-bottom:18px;border-color:rgba(92,225,255,.3);box-shadow:var(--glow)">
    <div class="row" style="flex-wrap:wrap"><div style="flex:1;min-width:260px"><div class="eyebrow">Make it automatic</div><h2 style="margin:0 0 4px;font-size:20px">Link Claude &amp; ChatGPT to Cortex</h2>
      <p class="small muted" style="margin:0">Two things per app: the <b>connector</b> (so it can reach Cortex) and the <b>instructions</b> (so it always works through Cortex). Each step is one click here plus one paste there.</p></div>
      <div class="target" style="min-width:300px"><b>Claude Code &amp; Codex on this PC</b>${done(pc)}<button class="btn sm ${pc ? '' : 'primary'}" data-instr="${pc ? 'uninstall' : 'install'}">${pc ? 'Remove' : 'Add to my instructions'}</button></div></div>
    <div class="row" style="flex-wrap:wrap;align-items:stretch;margin-top:12px">
      ${card('Claude', 'claude.ai, Claude apps, cloud sessions',
        step(1, 'Get your connector link', linkStep) +
        step(2, 'Add it to Claude', `<a class="btn sm" href="https://claude.ai/customize/connectors" target="_blank" rel="noopener">Open Claude connectors ↗</a> then <b>+ Add → Add custom connector</b>, paste the link, choose <b>No sign in</b>.`),
        step(3, 'Make Claude always use Cortex', `<button class="btn sm" data-copy-prompt>Copy instructions</button> <a class="btn sm" href="https://claude.ai/settings" target="_blank" rel="noopener">Open Claude settings ↗</a><br>Paste into your <b>personal preferences</b> (applies to every chat), or into a Claude <b>Project's instructions</b>. Then start a new chat.`))}
      ${card('ChatGPT', 'chatgpt.com and apps',
        step(1, 'Get your connector link', linkStep) +
        step(2, 'Add it to ChatGPT', `<a class="btn sm" href="https://chatgpt.com/" target="_blank" rel="noopener">Open ChatGPT ↗</a> then Settings → <b>Apps &amp; Connectors</b>, turn on <b>developer mode</b>, and create a connector with the link. Needs a plan that allows custom connectors. These menus couldn't be checked against ChatGPT's docs.`),
        step(3, 'Make ChatGPT always use Cortex', `<button class="btn sm" data-copy-prompt>Copy instructions</button> then Settings → <b>Personalization → Custom instructions</b>, or a ChatGPT <b>Project's instructions</b>.`))}
    </div>
    <p class="small muted" style="margin:8px 0 0">${st.connector.provider === 'tailscale' ? 'Your permanent link never changes: add it once per app.' : 'The quick link changes whenever Cortex restarts or updates. Use the permanent link (Tailscale) so you only add it once.'} Keep just <b>one</b> Cortex connector per app and delete old ones that point at dead links.</p>
  </div>`;
}
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
  let bk = null;
  try { bk = await api('/api/backups'); } catch { /* optional */ }
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
    ${L ? linkAppsHtml(st, c) : ''}
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
        <p class="small" style="margin-top:0">Hooks into Claude Code so that:</p>
        <ul class="small" style="margin-top:0;padding-left:18px;line-height:1.7">
          <li>every session starts with the project's Cortex brief, and related memories are added to each prompt;</li>
          <li>each step streams to Live and your phone, and your messages reach Claude while it works;</li>
          <li>every session is written to the project's agent journal, and the save gate asks Claude to record what it learned.</li>
        </ul>
        ${L ? `<div class="row"><span class="chip">${st.claudeHooks.installed ? '✓ Installed' : 'Not installed'}</span>${st.claudeHooks.installed ? '<button class="btn sm" data-hooks="uninstall">Uninstall</button>' : '<button class="btn sm primary" data-hooks="install">Install</button>'}</div>
          <p class="small muted">Adds hooks to <code>${esc(st.claudeHooks.settingsFile)}</code> (a backup is saved) and a <code>cortex</code> skill. Restart Claude Code afterwards.</p>` : '<p class="small muted">Install this from your computer.</p>'}
      </div>
      <div class="panel"><h3>${icon('i-bolt')} Agent control</h3>
        ${toggleRow('agents', st.agents.enabled, 'Let Cortex start agents on this computer', 'Start Claude Code or Codex from the Agents tab or your phone, inside the folders below only. Every run gets the Cortex brief and is recorded in the project journal.', !L)}
        ${toggleRow('gate', st.agents.saveGate, 'Save gate for Claude Code', 'If Claude changed things but saved nothing to Cortex, it is asked once to record what it learned before it finishes.', !L)}
        ${toggleRow('approvals', st.agents.phoneApprovals, 'Approve permission requests from Cortex', 'When Claude Code wants permission (run a command, edit a file), the request appears on Live and on your phone with Allow and Deny buttons. With no answer within 2 minutes, it asks on the computer as usual.', !L)}
        ${L ? `<div class="field"><label>Allowed folders (one per line)</label><textarea class="input" id="ag-folders" rows="3" placeholder="C:\\Users\\you\\Desktop\\SkyBlock Macros">${esc((st.agents.folders || []).join('\n'))}</textarea></div>
          <div class="grid2" style="margin-top:10px"><div class="field"><label>Permissions for started agents</label><select class="input" id="ag-perm">${opts(['default', 'acceptEdits', 'bypassPermissions'], st.agents.permission, { default: 'Ask first (read-only unless allowed)', acceptEdits: 'May edit files', bypassPermissions: 'Full access (dangerous)' })}</select></div>
          <div class="field"><label>Time limit per run (minutes)</label><input class="input" id="ag-max" type="number" min="5" max="600" value="${esc(st.agents.maxMinutes)}"></div></div>
          <div class="field" style="margin-top:10px"><label>Standing instructions for every agent</label><textarea class="input" id="ag-ins" rows="3" placeholder="e.g. Explain things simply. Never push to git without asking.">${esc(st.agents.instructions || '')}</textarea></div>
          <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary" id="ag-save">Save</button></div>` : ''}
      </div>
      <div class="panel"><h3>${icon('i-plug')} Connect AI apps</h3>
        ${L ? `<div class="field"><label>Prompt for your AI agents</label><div class="code"><pre class="wrap" style="max-height:160px">${esc(c.agentPrompt)}</pre><button class="btn sm copy" data-copy-prompt>${icon('i-copy')}</button></div><span class="small muted">Paste into CLAUDE.md, ChatGPT custom instructions, or a project's instructions so agents work through Cortex.</span></div>
        <h3 style="margin-top:18px">Cloud apps (claude.ai, ChatGPT)</h3>
        <p class="small" style="margin-top:-6px">Cloud apps can only reach a public <b>https</b> address. The <b>permanent link</b> (free Tailscale Funnel) never changes. The <b>quick link</b> (Cloudflare, no account) gets a new address on every restart.</p>
        ${publicLinkHtml(st)}
        <div class="row" style="margin-top:8px"><button class="btn sm ghost danger" id="cn-rotate">New secret link</button></div>
        ${st.connector.tunnel.url ? `<div class="field" style="margin-top:10px"><label>Connector URL (keep it secret: it gives full access)</label><div class="code"><pre class="wrap">${esc(st.connector.tunnel.url + '/mcp/' + st.connector.token)}</pre><button class="btn sm copy" data-copy-text="${esc(st.connector.tunnel.url + '/mcp/' + st.connector.token)}">${icon('i-copy')}</button></div>
          <ul class="small" style="padding-left:18px;line-height:1.8"><li><b>claude.ai</b>: Customize → Connectors → + Add → Add custom connector → paste the URL → choose <i>No sign in</i>.</li><li><b>ChatGPT</b>: turn on developer mode for connectors, then add a connector with this URL. ChatGPT's menus were not checked against its docs from here.</li></ul>
          <p class="small muted">${st.connector.provider === 'tailscale' ? 'This link is permanent. Add it once; it keeps working through restarts, updates and reboots.' : 'Quick-tunnel links change each time the tunnel restarts. Paste the new one when that happens.'} Have only <b>one</b> Cortex connector in each app: delete old ones that point at dead links.</p></div>` : ''}` : '<p class="small muted">Set this up on your computer.</p>'}
      </div>
      <div class="panel"><h3>${icon('i-search')} Search &amp; backups</h3>
        ${bk ? `<p class="small" style="margin-top:0"><b>Search by meaning:</b> ${bk.semantic.available ? `<span class="chip ok">on</span> ${bk.semantic.indexed} items indexed with ${esc(bk.semantic.model)} (local Ollama)` : `<span class="chip">keyword search</span> ${esc(bk.semantic.reason || '')}`}</p>
          <p class="small muted">Optional: install <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> and run <code>ollama pull nomic-embed-text</code> to also find notes by meaning. Everything stays on your computer.</p>
          <p class="small"><b>Backups:</b> one zip of the whole vault per day, last 14 kept in <code>.cortex/backups</code>. Every note also keeps its last 30 versions (History button in the editor).</p>
          <div class="list">${bk.backups.slice(0, 5).map((b) => `<div class="li"><span class="t">${esc(b.name)}</span><span class="meta">${(b.size / 1048576).toFixed(1)} MB</span></div>`).join('') || '<div class="empty">No backups yet.</div>'}</div>
          ${L ? '<div class="row" style="margin-top:10px"><button class="btn sm" id="bk-now">Back up now</button></div>' : ''}` : ''}
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
    const map = { remote: { remote: { enabled: on } }, screen: { screen: { enabled: on } }, auto: { updates: { auto: on } }, agents: { agents: { enabled: on } }, gate: { agents: { saveGate: on } }, approvals: { agents: { phoneApprovals: on } } };
    const body = map[cb.dataset.setting];
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
  on('ag-save', async () => {
    try { await api('/api/settings', { method: 'POST', body: { agents: { folders: $('#ag-folders').value, permission: $('#ag-perm').value, maxMinutes: $('#ag-max').value, instructions: $('#ag-ins').value } } }); toast('Agent settings saved'); renderSettings(); } catch (e) { fail(e); }
  });
  on('cn-rotate', async () => { if (!confirm('Make a new secret connector link? Apps using the old link will stop working.')) return; await api('/api/settings', { method: 'POST', body: { rotateConnector: true } }).catch(fail); renderSettings(); });
  $$('[data-tunnel]').forEach((b) => (b.onclick = async () => {
    const action = b.dataset.tunnel;
    b.disabled = true; b.textContent = action === 'start' ? 'Working… (up to 30s)' : action === 'check' ? 'Checking…' : 'Turning off…';
    // errors (e.g. "Funnel not turned on yet") are shown in the panel itself
    await api('/api/tunnel', { method: 'POST', body: { action, provider: b.dataset.provider } }).catch(() => {});
    renderSettings();
  }));
  $$('[data-instr]').forEach((b) => (b.onclick = async () => {
    try {
      const r = await api('/api/instructions', { method: 'POST', body: { action: b.dataset.instr } });
      const added = r.filter((x) => x.file && !x.skipped);
      if (b.dataset.instr === 'uninstall') toast('Removed the Cortex block from your instruction files');
      else if (!added.length) toast('Claude Code or Codex was not found on this PC. Install one, then try again.', true);
      else toast(`Added to ${added.map((x) => x.file).join(' and ')}. New sessions will use Cortex automatically.`);
      renderSettings();
    } catch (e) { fail(e); }
  }));
  on('bk-now', async () => { try { const r = await api('/api/backups', { method: 'POST' }); toast(`Backed up ${r.files} files`); renderSettings(); } catch (e) { fail(e); } });
  $$('[data-copy-prompt]').forEach((b) => (b.onclick = () => copy(c.agentPrompt)));
  $$('[data-copy-text]').forEach((b) => (b.onclick = () => copy(b.dataset.copyText)));
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
  const nt = e.target.closest('[data-approve],[data-stop-run],[data-mfetch],[data-mproc],[data-mind],[data-cmd-del]');
  if (nt) {
    if (nt.dataset.approve) api('/api/approvals', { method: 'POST', body: { id: nt.dataset.approve, decision: nt.dataset.d } }).then(() => { toast(nt.dataset.d === 'allow' ? 'Allowed' : 'Denied'); updateLive(); }).catch(fail);
    else if (nt.dataset.stopRun) api('/api/agents/stop', { method: 'POST', body: { id: nt.dataset.stopRun } }).then(() => toast('Stopping…')).catch(fail);
    else if (nt.dataset.mfetch) { e.stopPropagation(); toast('Fetching…'); api('/api/mind/fetch', { method: 'POST', body: { id: nt.dataset.mfetch } }).then(() => { toast('Fetched'); refresh(); }).catch((er) => { fail(er); refresh(); }); }
    else if (nt.dataset.mproc) { e.stopPropagation(); processMind(nt.dataset.mproc); }
    else if (nt.dataset.cmdDel) api('/api/commands?id=' + encodeURIComponent(nt.dataset.cmdDel), { method: 'DELETE' }).then(() => renderAgents()).catch(fail);
    else if (nt.dataset.mind && !e.target.closest('a,button')) openMind(nt.dataset.mind);
    return;
  }
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
  else if (act === 'send-agent') { closeModal(); store.set('hubTab', 'launch'); if (t.dataset.project) store.set('lastProj', t.dataset.project); HUB.pendingTask = t.dataset.task || ''; go('agents'); }
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
