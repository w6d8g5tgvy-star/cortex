// Cortex 2.2 screens: notification bell, "Tell Cortex what to do" (typed or spoken), and the Intelligence panel
// (performance profiles, known pitfalls, improvements, model routing, emergency stop). Adds to existing pages only.
(() => {
  const css = `
  .ib-bell{position:relative;background:none;border:1px solid var(--edge,rgba(255,255,255,.1));border-radius:10px;color:var(--text-2,#aab);cursor:pointer;padding:6px 9px;margin-left:8px}
  .ib-bell b{position:absolute;top:-6px;right:-6px;background:#ff5d7a;color:#fff;border-radius:999px;font-size:10px;padding:1px 5px}
  .ib-pop{position:fixed;top:60px;right:16px;width:min(380px,92vw);max-height:70vh;overflow:auto;z-index:60;padding:12px;border-radius:14px;background:var(--panel,#0e1022);border:1px solid var(--edge-2,rgba(255,255,255,.15));box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .ib-n{padding:9px 10px;border-radius:10px;margin-top:6px;border:1px solid var(--edge,rgba(255,255,255,.08))}.ib-n.unread{border-color:rgba(124,92,255,.55)}
  .ib-n .k{font-size:11px;color:var(--text-3,#889)}
  .cc-in{display:flex;gap:8px}.cc-in input{flex:1}
  .cc-out{margin-top:10px}
  .in-tbl{width:100%;border-collapse:collapse;font-size:12.5px}.in-tbl th,.in-tbl td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--edge,rgba(255,255,255,.06));vertical-align:top}
  .in-u{color:var(--text-3,#889);font-style:italic}.in-n{color:var(--text-3,#889);font-size:11px}
  .in-sec{margin-top:14px}.in-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .in-imp{padding:9px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:6px}
  .estop{background:linear-gradient(90deg,#ff4d6d,#ff7a59)!important;color:#fff!important;border:0!important}
  @media (max-width:640px){.in-tbl .hide-sm{display:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const pct = (m) => (m && m.source === 'measured' && m.value !== null ? `${Math.round(m.value * 100)}% <span class="in-n">n=${m.n}</span>` : `<span class="in-u" title="${esc((m && m.note) || '')}">unavailable</span>`);
  const val = (m, f) => (m && m.source === 'measured' && m.value !== null ? `${f(m.value)} <span class="in-n">n=${m.n}</span>` : `<span class="in-u" title="${esc((m && m.note) || '')}">unavailable</span>`);

  // ---------------- notification bell (polls cheaply; no background work when the tab is hidden) ----------------
  let lastSeen = null; let bell;
  async function pollNotes() {
    if (document.hidden) return;
    let d; try { d = await api('/api/notifications'); } catch { return; }
    if (!bell) {
      const bar = document.querySelector('.topbar, header, .top') || document.body;
      bell = document.createElement('button'); bell.className = 'ib-bell'; bell.title = 'Notifications'; bell.setAttribute('aria-label', 'Notifications');
      (bar.querySelector('.top-right, .row:last-child') || bar).appendChild(bell);
      bell.onclick = () => togglePop();
    }
    bell.innerHTML = `🔔${d.unread ? `<b>${d.unread}</b>` : ''}`;
    const newest = d.items.find((n) => !n.read);
    if (newest && lastSeen && newest.updated > lastSeen && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`Cortex · ${newest.label}`, { body: `${newest.title}${newest.count > 1 ? ` (×${newest.count})` : ''}`, tag: newest.key, icon: '/icon-192.png' }); } catch { /* not allowed here */ }
    }
    lastSeen = (d.items[0] || {}).updated || lastSeen || new Date().toISOString();
  }
  async function togglePop() {
    const old = document.getElementById('ib-pop'); if (old) return old.remove();
    const d = await api('/api/notifications');
    const p = document.createElement('div'); p.id = 'ib-pop'; p.className = 'ib-pop';
    p.innerHTML = `<div class="in-row"><b style="flex:1">Notifications</b>${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn sm" id="ib-allow">Show on this device</button>' : ''}<button class="btn sm ghost" id="ib-read">Mark all read</button></div>
      ${d.items.length ? d.items.map((n) => `<div class="ib-n ${n.read ? '' : 'unread'}"><div class="k">${esc(n.label)} · ${timeAgo(n.updated)}${n.count > 1 ? ` · ×${n.count}` : ''}</div><b style="font-size:13px">${esc(n.title)}</b>${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}</div>`).join('') : '<div class="small muted" style="margin-top:8px">Nothing yet. Approvals, finished or failed work, quality checks, usage limits and backup problems show up here.</div>'}`;
    document.body.appendChild(p);
    const r = p.querySelector('#ib-read'); if (r) r.onclick = async () => { await api('/api/notifications/read', { method: 'POST', body: { ids: 'all' } }); p.remove(); pollNotes(); };
    const a = p.querySelector('#ib-allow'); if (a) a.onclick = async () => { try { await Notification.requestPermission(); } catch { /* ignored */ } p.remove(); };
  }
  setTimeout(pollNotes, 1500); setInterval(pollNotes, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotes(); });

  // ---------------- "Tell Cortex what to do" (Home) ----------------
  function commandPanel() {
    const main = document.querySelector('#main');
    if (!main || main.querySelector('#cc-panel')) return;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'cc-panel'; p.style.marginBottom = '16px';
    const voice = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
    p.innerHTML = `<h3 style="margin-top:0">Tell Cortex what to do</h3>
      <form class="cc-in" id="cc-f"><input class="input" id="cc-q" placeholder="e.g. continue my work on Shop · launch an agent to fix the login bug · connect my phone · turn on phone access" autocomplete="off">${voice ? '<button type="button" class="btn" id="cc-mic" title="Speak">🎤</button>' : ''}<button class="btn primary">Go</button></form>
      <div class="cc-out" id="cc-out"></div>`;
    const head = main.querySelector('.page-head'); if (head && head.nextSibling) head.parentNode.insertBefore(p, head.nextSibling); else main.prepend(p);
    const out = p.querySelector('#cc-out');
    const run = async (text, confirm) => {
      let r; try { r = await api('/api/command', { method: 'POST', body: { text, confirm } }); } catch (e) { out.innerHTML = `<div class="small" style="color:var(--bad)">${esc(e.message)}</div>`; return; }
      if (r.intent === 'unknown') { out.innerHTML = `<div class="small muted">I didn't understand that. Try: ${r.suggestions.slice(0, 6).map((s) => `<a href="javascript:void 0" data-cc="${esc(s)}">${esc(s)}</a>`).join(' · ')}</div>`; out.querySelectorAll('[data-cc]').forEach((a) => (a.onclick = () => { p.querySelector('#cc-q').value = a.dataset.cc; })); return; }
      if (r.needsConfirm) { out.innerHTML = `<div class="ss-box"><b>${esc(r.summary)}</b><div class="row" style="gap:8px;margin-top:8px"><button class="btn primary sm" id="cc-yes">Confirm</button><button class="btn sm" id="cc-no">Cancel</button></div></div>`; out.querySelector('#cc-yes').onclick = () => run(text, true); out.querySelector('#cc-no').onclick = () => { out.innerHTML = ''; }; return; }
      out.innerHTML = `<div class="small">✓ ${esc(r.summary)}${r.note ? ' · ' + esc(r.note) : ''}${r.results ? '<br>' + (r.results.map((x) => `<a href="#/${x.kind === 'note' ? 'memory/' + encodeURIComponent(x.id) : x.kind === 'project' ? 'projects/' + encodeURIComponent(x.id.split('/')[1]) : 'board'}">${esc(x.title)}</a>`).join(' · ') || 'no results') : ''}${r.route ? `<br><span class="muted">Model: ${esc(r.route.model || 'default')} (${esc((r.route.reasons || []).join('; '))})</span>` : ''}</div>`;
      if (r.reload) setTimeout(() => location.reload(), 600);
      else if (r.go && !r.results) setTimeout(() => { location.hash = r.go; }, 900);
    };
    p.querySelector('#cc-f').onsubmit = (e) => { e.preventDefault(); const q = p.querySelector('#cc-q').value.trim(); if (q) run(q, false); };
    const mic = p.querySelector('#cc-mic');
    if (mic) mic.onclick = () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const rec = new SR();
      rec.lang = navigator.language || 'en-US'; rec.interimResults = false; mic.textContent = '…';
      rec.onresult = (ev) => { const said = ev.results[0][0].transcript; p.querySelector('#cc-q').value = said; run(said, false); }; // sensitive actions still ask to confirm
      rec.onend = () => { mic.textContent = '🎤'; }; rec.onerror = () => { mic.textContent = '🎤'; };
      rec.start();
    };
  }

  // ---------------- Intelligence panel (Agents page) ----------------
  async function intelPanel() {
    const main = document.querySelector('#main');
    if (!main || main.querySelector('#in-panel')) return;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'in-panel'; p.style.marginBottom = '16px';
    const jb = main.querySelector('#jb-panel'); if (jb && jb.nextSibling) jb.parentNode.insertBefore(p, jb.nextSibling); else main.appendChild(p);
    const draw = async () => {
      let d; try { d = await api('/api/intel'); } catch (e) { p.innerHTML = `<h3>Intelligence</h3><div class="small muted">${esc(e.message)}</div>`; return; }
      const local = !!(await api('/api/settings').catch(() => ({}))).local;
      const imps = d.improvements;
      p.innerHTML = `<div class="in-row"><h3 style="margin:0;flex:1">🧠 Intelligence</h3><button class="btn sm estop" id="in-stop" title="Stops every running agent, job and research run">■ Emergency stop</button></div>
        <p class="small muted" style="margin:4px 0 0">How your agents perform, what goes wrong, and tested improvements. Numbers are measured from recorded runs (n = how many); "unavailable" means nothing was measured, never a guess.</p>
        <div class="in-sec"><b class="small">Performance by agent and model</b>
        ${d.profiles.length ? `<table class="in-tbl"><tr><th>Agent · model</th><th>Success</th><th class="hide-sm">Avg cost</th><th class="hide-sm">Avg minutes</th><th class="hide-sm">Output tokens</th><th>Quality checks</th></tr>${d.profiles.slice(0, 10).map((x) => `<tr><td>${esc(x.agent)}</td><td>${pct(x.successRate)}</td><td class="hide-sm">${val(x.avgCost, (v) => '$' + v.toFixed(3))}</td><td class="hide-sm">${val(x.avgMinutes, (v) => v.toFixed(1))}</td><td class="hide-sm">${val(x.avgOutputTokens, (v) => Math.round(v))}</td><td>${pct(x.qaPassRate)}</td></tr>`).join('')}</table>` : '<div class="small muted">No finished agent runs recorded yet.</div>'}</div>
        <div class="in-sec"><div class="in-row"><b class="small" style="flex:1">Known pitfalls (${d.failureStats.total}, ${d.failureStats.withFix} with a fix)</b><button class="btn sm" id="in-scan">Look for patterns</button></div>
        ${d.failures.slice(0, 6).map((f) => `<div class="in-imp"><b style="font-size:12.5px">${esc(f.type)}${f.count > 1 ? ` · ${f.count}×` : ''}</b> <span class="small">${esc(f.task)}</span>${f.fix ? `<div class="small muted">Fix: ${esc(f.fix)}</div>` : ''}</div>`).join('') || '<div class="small muted">None recorded. Cortex learns them from agent journals and from agents\' failure reports.</div>'}</div>
        <div class="in-sec"><b class="small">Improvements</b> <span class="small muted">(applied only after a test beats the baseline; can always be undone)</span>
        ${imps.slice(0, 8).map((x) => `<div class="in-imp"><div class="in-row"><b style="flex:1;font-size:13px">${esc(x.title)}</b><span class="small muted">${esc(x.status)}</span></div><div class="small muted">${esc(x.change.slice(0, 220))}</div>${x.baseline ? `<div class="small">Baseline: ${esc(x.baseline.metric)} = ${x.baseline.value} (n=${x.baseline.n})${x.result ? ` · test: ${x.result.value} (n=${x.result.n})` : ''}${x.measured ? ` · measured after: ${x.measured.value} (n=${x.measured.n})` : ''}</div>` : ''}
          <div class="in-row" style="margin-top:6px">${x.status === 'verified' && local ? `<button class="btn sm primary" data-imp="apply" data-id="${x.id}">Apply</button>` : ''}${['proposed', 'testing'].includes(x.status) && local ? `<button class="btn sm" data-imp="force" data-id="${x.id}">Try it as an experiment</button>` : ''}${x.status === 'applied' ? `<button class="btn sm" data-imp="rollback" data-id="${x.id}">Undo</button>` : ''}${['proposed', 'testing', 'verified'].includes(x.status) ? `<button class="btn sm ghost" data-imp="reject" data-id="${x.id}">Reject</button>` : ''}</div></div>`).join('') || '<div class="small muted">No proposals yet. Recurring problems with a known fix become proposals automatically.</div>'}</div>
        <div class="in-sec"><div class="in-row"><b class="small" style="flex:1">Model routing</b>${local ? `<select class="input" id="in-mode" style="width:auto"><option value="suggest" ${d.routing.settings.mode === 'suggest' ? 'selected' : ''}>Suggest only</option><option value="auto" ${d.routing.settings.mode === 'auto' ? 'selected' : ''}>Choose automatically</option><option value="manual" ${d.routing.settings.mode === 'manual' ? 'selected' : ''}>Always my default</option></select>` : `<span class="small">${esc(d.routing.settings.mode)}</span>`}</div>
        <form class="cc-in" id="in-rt" style="margin-top:6px"><input class="input" id="in-rq" placeholder="Try it: describe a task"><button class="btn sm">Which model?</button></form><div id="in-ro" class="small" style="margin-top:4px"></div></div>`;
      p.querySelector('#in-stop').onclick = async () => { if (!confirm('Stop every running agent, job and Fetcher research now?')) return; try { const r = await api('/api/emergency-stop', { method: 'POST' }); toast(`Stopped ${r.runs} runs, ${r.jobs} jobs, ${r.research} research`); } catch (e) { fail(e); } };
      p.querySelector('#in-scan').onclick = async () => { try { const r = await api('/api/intel/improvements', { method: 'POST', body: { action: 'scan' } }); toast(`${r.mined.added} new pitfalls, ${r.proposed} proposals`); draw(); } catch (e) { fail(e); } };
      p.querySelectorAll('[data-imp]').forEach((b) => (b.onclick = async () => { const a = b.dataset.imp; try { await api('/api/intel/improvements', { method: 'POST', body: { action: a === 'force' ? 'apply' : a, force: a === 'force', id: b.dataset.id } }); draw(); } catch (e) { fail(e); } }));
      const mode = p.querySelector('#in-mode'); if (mode) mode.onchange = async () => { try { await api('/api/intel/routing', { method: 'POST', body: { mode: mode.value } }); toast('Saved'); } catch (e) { fail(e); } };
      p.querySelector('#in-rt').onsubmit = async (e) => { e.preventDefault(); const q = p.querySelector('#in-rq').value.trim(); if (!q) return; try { const r = await api('/api/intel/route', { method: 'POST', body: { prompt: q } }); p.querySelector('#in-ro').innerHTML = `<b>${esc(r.tool === 'codex' ? 'Codex' : 'Claude ' + (r.model || 'default'))}</b> · ${esc((r.reasons || []).join('; ') || 'medium task')}`; } catch (err) { fail(err); } };
    };
    draw();
  }

  // ---------------- Skills → versions ----------------
  async function skillVersions() {
    const main = document.querySelector('#main'); if (!main) return;
    main.querySelectorAll('[data-sk-edit]').forEach((btn) => {
      const name = String(btn.dataset.skEdit).replace(/^skills\//, '');
      if (btn.parentNode.querySelector('[data-sk-ver]')) return;
      const v = document.createElement('button'); v.className = 'btn sm ghost'; v.dataset.skVer = name; v.textContent = 'Versions';
      btn.after(v);
      v.onclick = async () => {
        const box = btn.closest('.panel, .card, div').querySelector('.sk-ver') || Object.assign(document.createElement('div'), { className: 'sk-ver in-sec' });
        btn.closest('.row').after(box);
        try {
          const d = await api('/api/skills/versions?name=' + encodeURIComponent(name));
          box.innerHTML = d.versions.map((x) => `<div class="in-imp"><div class="in-row"><b style="flex:1;font-size:12.5px">v${x.version} · ${esc(x.status)}</b><span class="small muted">${esc(x.by || '')} · ${timeAgo(x.at)}</span></div><div class="small muted">used ${x.uses}× · helped ${x.helpedRate.n ? Math.round(x.helpedRate.value * 100) + '% of ' + x.helpedRate.n + ' reports' : 'no reports yet'}${x.models.length ? ' · works with ' + esc(x.models.join(', ')) : ''}${x.note ? ' · ' + esc(x.note) : ''}</div>${x.status !== 'default' ? `<button class="btn sm" data-sk-def="${x.version}">Make default</button>` : ''}</div>`).join('');
          box.querySelectorAll('[data-sk-def]').forEach((b2) => (b2.onclick = async () => { try { await api('/api/skills/versions', { method: 'POST', body: { name, version: Number(b2.dataset.skDef) } }); toast('Default changed'); v.click(); } catch (e) { fail(e); } }));
        } catch (e) { fail(e); }
      };
    });
  }

  // ---------------- Simple / Advanced mode + hidden panels ----------------
  const ADV_PAGES = ['graph', 'skills', 'fetcher'];
  const PANELS = { 'cc-panel': 'Tell Cortex what to do', 'gs-panel': 'Get set up', 'in-panel': 'Intelligence', 'jb-panel': 'Run on your computers', 'ss-panel': 'SmartSave (project page)' };
  let UI = { mode: 'advanced', hidePanels: [] };
  const uiCss = document.createElement('style'); document.head.appendChild(uiCss);
  function applyUi() {
    document.body.classList.toggle('mode-simple', UI.mode === 'simple');
    uiCss.textContent = (UI.mode === 'simple' ? ADV_PAGES.map((p) => `body.mode-simple [data-go="${p}"]`).join(',') + '{display:none!important} body.mode-simple #in-panel .in-tbl, body.mode-simple #in-panel #in-rt{display:none}' : '') + (UI.hidePanels || []).map((id) => `#${id}{display:none!important}`).join('');
  }
  api('/api/ui').then((u) => { UI = u; applyUi(); }).catch(() => {});
  async function uiPanel() {
    const grid = document.querySelector('.settings-grid'); if (!grid || grid.querySelector('#ui-set')) return;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'ui-set';
    let fc = null; try { fc = await api('/api/usage/forecast'); } catch { /* optional */ }
    p.innerHTML = `<h3>Interface</h3><div class="in-row"><span class="small" style="flex:1">Mode</span><span class="seg"><button type="button" data-ui-mode="simple" class="${UI.mode === 'simple' ? 'on' : ''}">Simple</button><button type="button" data-ui-mode="advanced" class="${UI.mode !== 'simple' ? 'on' : ''}">Advanced</button></span></div>
      <p class="small muted">Simple hides the Neural map, Skills and Fetcher pages and the detailed numbers. Nothing is removed; switch back any time.</p>
      <div class="small" style="margin-top:8px"><b>Show these panels</b></div>${Object.entries(PANELS).map(([id, label]) => `<label class="small" style="display:block;margin-top:4px"><input type="checkbox" data-ui-panel="${id}" ${(UI.hidePanels || []).includes(id) ? '' : 'checked'}> ${esc(label)}</label>`).join('')}
      ${fc ? `<div class="in-sec"><b class="small">Usage forecast</b>${Object.values(fc.tools).map((t) => `<div class="small" style="margin-top:4px">${esc(t.label)}: ${Math.round(t.tokensToday / 1000)}k tokens today · ~${Math.round(t.perHour / 1000)}k/hour · limit: ${t.limit && t.limit.usedPercent !== null ? `${Math.round(t.limit.usedPercent)}% used${t.limit.projectedFullAt ? `, full around ${new Date(t.limit.projectedFullAt).toLocaleTimeString()}` : ', lasts until it resets'}` : `<span class="in-u">${esc(t.limit ? t.limit.source : 'unknown')}</span>`}</div>`).join('')}${fc.warnings.map((w) => `<div class="small" style="color:var(--warn)">⚠ ${esc(w)}</div>`).join('')}${fc.suggestions.map((w) => `<div class="small muted">💡 ${esc(w)}</div>`).join('')}</div>` : ''}`;
    grid.prepend(p);
    p.querySelectorAll('[data-ui-mode]').forEach((b) => (b.onclick = async () => { UI = await api('/api/ui', { method: 'POST', body: { mode: b.dataset.uiMode } }); applyUi(); p.remove(); uiPanel(); }));
    p.querySelectorAll('[data-ui-panel]').forEach((c) => (c.onchange = async () => { const hide = [...p.querySelectorAll('[data-ui-panel]')].filter((x) => !x.checked).map((x) => x.dataset.uiPanel); UI = await api('/api/ui', { method: 'POST', body: { hidePanels: hide } }); applyUi(); }));
  }

  const wrap = (name, after) => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); Promise.resolve(r).then(() => after()).catch((e) => console.warn(name, e)); return r; }; };
  wrap('renderHome', () => { if (S.route[0] === 'home') commandPanel(); });
  wrap('renderAgents', () => { if (S.route[0] === 'agents') return intelPanel(); });
  wrap('renderSkills', () => { if (S.route[0] === 'skills') return skillVersions(); });
  wrap('renderSettings', () => { if (S.route[0] === 'settings') return uiPanel(); });
})();
