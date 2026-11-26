// Devices + agent jobs: pair phones and computers with a short code, see which are online, and start Claude Code /
// Codex on this or another computer (with approvals for requests that come from AI agents).
(() => {
  const css = `
  .dv-list{display:grid;gap:8px;margin:10px 0}
  .dv{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--edge,rgba(255,255,255,.08));background:rgba(255,255,255,.02)}
  .dv .dot{width:9px;height:9px;border-radius:50%;background:#555;flex:none}
  .dv .dot.on{background:#3ee08f;box-shadow:0 0 10px #3ee08f}
  .dv .grow{flex:1;min-width:0}.dv .grow b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dv-pair{margin-top:10px;padding:14px;border-radius:14px;border:1px solid rgba(124,92,255,.45);background:rgba(124,92,255,.06)}
  .dv-code{font:700 28px ui-monospace,monospace;letter-spacing:4px;color:#fff;margin:4px 0}
  .dv-qr{float:right;margin:0 0 8px 12px;background:#fff;border-radius:10px;padding:6px;line-height:0}
  .dv-qr img,.dv-qr svg{width:132px;height:132px}
  .jb-form{display:grid;gap:10px}
  .jb-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .jb{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:8px}
  .jb.ask{border-color:rgba(124,92,255,.6);box-shadow:inset 0 0 0 1px rgba(124,92,255,.2)}
  .jb .grow{flex:1;min-width:0}.jb .st{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--edge-2,rgba(255,255,255,.15));white-space:nowrap}
  .jb .st.running{color:#47e3ff;border-color:rgba(71,227,255,.5)}.jb .st.done{color:#3ee08f}.jb .st.error{color:#ff8c8c}
  .jb-btns{display:flex;gap:6px;flex-shrink:0}
  @media (max-width:640px){.jb-row{grid-template-columns:1fr}.jb{flex-wrap:wrap}.dv-qr{float:none;margin:0 0 8px}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const ago = (iso) => (iso ? timeAgo(iso) : 'never');
  const STATUS = { 'needs-approval': 'Waiting for your OK', queued: 'Queued', running: 'Running', done: 'Done', error: 'Failed', stopped: 'Stopped', rejected: 'Declined' };

  // ---------------- Settings → Devices ----------------
  async function devicesPanel(grid, local) {
    if (!grid || grid.querySelector('#dv-panel')) return;
    const panel = document.createElement('div');
    panel.className = 'panel'; panel.id = 'dv-panel';
    grid.prepend(panel);
    const draw = async () => {
      let d; try { d = await api('/api/devices'); } catch (e) { panel.innerHTML = `<h3>Devices</h3><div class="muted small">${esc(e.message)}</div>`; return; }
      const phones = d.devices.filter((x) => x.kind === 'phone'); const comps = d.devices.filter((x) => x.kind === 'computer');
      const row = (x) => `<div class="dv"><span class="dot ${x.online ? 'on' : ''}" title="${x.online ? 'Online' : 'Offline'}"></span><div class="grow"><b>${esc(x.name)}</b><span class="small muted">${x.kind === 'computer' ? 'Computer' : 'Phone'} · ${x.online ? 'online now' : 'last seen ' + ago(x.lastSeen)}${x.platform ? ' · ' + esc(x.platform) : ''}</span></div>${local ? `<button class="btn sm ghost" data-dv-rename="${esc(x.id)}">Rename</button><button class="btn sm danger" data-dv-remove="${esc(x.id)}">Remove</button>` : ''}</div>`;
      panel.innerHTML = `<h3>${icon('i-phone')} Devices</h3>
        <p class="small muted" style="margin-top:0">Phones open this dashboard. Computers can run agent jobs for this Cortex. Each device has its own key, so you can remove one without affecting the others.</p>
        <div class="dv-list"><div class="dv"><span class="dot on"></span><div class="grow"><b>This computer</b><span class="small muted">Runs Cortex · online</span></div></div>${[...comps, ...phones].map(row).join('')}</div>
        ${local ? `<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn primary sm" data-dv-add="phone">${icon('i-phone')} Add a phone</button><button class="btn sm" data-dv-add="computer">${icon('i-bolt')} Add a computer</button></div><div id="dv-pair"></div>` : '<p class="small muted">Add or remove devices on the computer running Cortex.</p>'}`;
      panel.querySelectorAll('[data-dv-remove]').forEach((b) => (b.onclick = async () => { if (!confirm('Remove this device? It will need a new code to connect again.')) return; try { await api('/api/devices/revoke', { method: 'POST', body: { id: b.dataset.dvRemove } }); toast('Device removed'); draw(); } catch (e) { fail(e); } }));
      panel.querySelectorAll('[data-dv-rename]').forEach((b) => (b.onclick = async () => { const n = prompt('New name for this device'); if (!n) return; try { await api('/api/devices/rename', { method: 'POST', body: { id: b.dataset.dvRename, name: n } }); draw(); } catch (e) { fail(e); } }));
      panel.querySelectorAll('[data-dv-add]').forEach((b) => (b.onclick = () => showCode(b.dataset.dvAdd)));
    };
    const showCode = async (kind) => {
      const box = panel.querySelector('#dv-pair');
      let c; try { c = await api('/api/devices/code', { method: 'POST', body: { kind } }); } catch (e) { return fail(e); }
      let st = {}; try { st = await api('/api/settings'); } catch { /* optional */ }
      const addrs = (st.remote && st.remote.addresses) || [];
      const best = addrs.find((a) => a.kind === 'public') || addrs.find((a) => a.kind === 'tailscale') || addrs[0];
      const base = best ? best.url.replace(/\/$/, '') : location.origin;
      const end = Date.parse(c.expiresAt);
      if (kind === 'phone') {
        const url = base + c.phoneUrl;
        box.innerHTML = `<div class="dv-pair"><div class="dv-qr" id="dv-qr"></div><b>Pair a phone</b><div class="small muted">1. Scan the QR code with the phone's camera (or open the link). 2. Tap <b>Pair</b>.</div><div class="dv-code">${esc(c.code)}</div><div class="small muted" id="dv-left"></div><div class="code" style="margin-top:8px"><pre>${esc(url)}</pre></div>${st.remote && !st.remote.enabled ? '<p class="small" style="color:var(--warn)">Turn on <b>Allow my phone to connect</b> first.</p>' : ''}<div style="clear:both"></div></div>`;
        const q = box.querySelector('#dv-qr');
        if (window.qrcode) { const qr = qrcode(0, 'M'); qr.addData(url); qr.make(); q.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 }); } else q.remove();
      } else {
        const cmd = `node bin/cortex.js runner --hub ${base} --code ${c.code} --standby`;
        const link = base + (c.installUrl || `/i/${encodeURIComponent(c.code)}`);
        box.innerHTML = `<div class="dv-pair"><div class="dv-qr" id="dv-qr"></div><b>Add a computer</b><div class="small muted"><b>No terminal needed:</b> on the other computer, open this link in a browser, download the installer and double-click it. It installs everything, connects to this Cortex and can keep a standby copy for when this computer is off.</div><div class="code" style="margin-top:8px"><pre id="dv-link">${esc(link)}</pre><button class="btn sm copy" id="dv-copy-l">${icon('i-copy')}</button></div><div class="dv-code">${esc(c.code)}</div><div class="small muted" id="dv-left"></div>${st.remote && !st.remote.enabled ? '<p class="small" style="color:var(--warn)">Turn on <b>Allow my phone to connect</b> first, so other computers can reach this Cortex.</p>' : ''}<details style="margin-top:8px"><summary class="small">Already have Cortex there? Use a command instead</summary><div class="code" style="margin-top:6px"><pre id="dv-cmd">${esc(cmd)}</pre><button class="btn sm copy" id="dv-copy">${icon('i-copy')}</button></div></details><p class="small muted">After pairing it appears in this list with a green dot while it's running.</p><div style="clear:both"></div></div>`;
        const q2 = box.querySelector('#dv-qr'); if (window.qrcode) { const qr = qrcode(0, 'M'); qr.addData(link); qr.make(); q2.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0 }); } else q2.remove();
        box.querySelector('#dv-copy-l').onclick = () => { navigator.clipboard.writeText(link).then(() => toast('Link copied')); };
        box.querySelector('#dv-copy').onclick = () => { navigator.clipboard.writeText(cmd).then(() => toast('Copied')); };
      }
      const tick = () => { const left = Math.max(0, Math.round((end - Date.now()) / 1000)); const el = box.querySelector('#dv-left'); if (!el) return; el.textContent = left ? `Code works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : 'Code expired: make a new one.'; if (left) setTimeout(tick, 1000); else draw(); };
      tick();
      const poll = setInterval(async () => { if (!document.body.contains(box)) return clearInterval(poll); try { const d = await api('/api/devices'); if (d.devices.some((x) => Date.now() - Date.parse(x.created) < 15000)) { clearInterval(poll); toast('Device paired'); draw(); } } catch { /* keep waiting */ } }, 3000);
    };
    draw();
  }

  // ---------------- Agents → Run on your computers ----------------
  async function jobsPanel(main) {
    if (!main || main.querySelector('#jb-panel')) return;
    const head = main.querySelector('.page-head');
    const panel = document.createElement('div');
    panel.className = 'panel'; panel.id = 'jb-panel'; panel.style.marginBottom = '16px';
    if (head && head.nextSibling) head.parentNode.insertBefore(panel, head.nextSibling); else main.prepend(panel);
    let d;
    const draw = async () => {
      try { d = await api('/api/jobs'); } catch (e) { panel.innerHTML = `<h3>Run on your computers</h3><div class="muted small">${esc(e.message)}</div>`; return; }
      const asks = d.jobs.filter((j) => j.status === 'needs-approval');
      const recent = d.jobs.filter((j) => j.status !== 'needs-approval').slice(0, 6);
      const jobRow = (j) => `<div class="jb ${j.status === 'needs-approval' ? 'ask' : ''}"><div class="grow"><b>${esc(String(j.prompt || j.task || '').slice(0, 140))}</b><div class="small muted">${esc(j.deviceName)} · ${j.tool === 'codex' ? 'Codex' : 'Claude Code'}${j.model ? ' · ' + esc(j.model) : ''} · from ${esc(j.from)} · ${ago(j.created)}${j.step && j.status !== 'needs-approval' ? ' · ' + esc(String(j.step).slice(0, 120)) : ''}</div></div><span class="st ${esc(j.status)}">${esc(STATUS[j.status] || j.status)}</span><div class="jb-btns">${j.status === 'needs-approval' ? `<button class="btn sm primary" data-jb-ok="${esc(j.id)}">Approve</button><button class="btn sm" data-jb-no="${esc(j.id)}">Decline</button>` : ['queued', 'running'].includes(j.status) ? `<button class="btn sm danger" data-jb-stop="${esc(j.id)}">Stop</button>` : ['error', 'stopped'].includes(j.status) ? `<button class="btn sm" data-jb-retry="${esc(j.id)}">Retry</button>` : ''}</div></div>`;
      const comps = d.computers.map((c) => `<option value="${esc(c.id)}" ${c.online ? '' : 'disabled'}>${esc(c.name)}${c.online ? '' : ' (offline)'}</option>`).join('');
      panel.innerHTML = `<h3>${icon('i-bolt')} Run on your computers</h3>
        ${asks.length ? `<div class="small" style="margin-bottom:4px"><b>${asks.length} request${asks.length === 1 ? '' : 's'} from AI agents waiting for your OK</b></div>${asks.map(jobRow).join('')}<div style="height:12px"></div>` : ''}
        <form class="jb-form" id="jb-form"><textarea class="input" id="jb-prompt" rows="2" placeholder="What should the agent do? e.g. Fix the failing login test"></textarea>
          <div class="jb-row"><select class="input" id="jb-dev" aria-label="Computer">${comps}</select><select class="input" id="jb-proj" aria-label="Project">${projectOptions('', 'No project')}</select><select class="input" id="jb-tool" aria-label="Agent"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></div>
          <div class="row"><span class="small muted" style="flex:1">Runs in the project's folder (or your first allowed folder) on that computer. You can stop it any time.</span><button class="btn primary">${icon('i-bolt')} Start</button></div></form>
        ${recent.length ? `<div class="small muted" style="margin-top:12px">Recent jobs</div>${recent.map(jobRow).join('')}` : ''}`;
      panel.querySelector('#jb-form').onsubmit = async (e) => {
        e.preventDefault();
        const prompt = panel.querySelector('#jb-prompt').value.trim();
        if (!prompt) return toast('Say what the agent should do', true);
        try { await api('/api/jobs', { method: 'POST', body: { prompt, device: panel.querySelector('#jb-dev').value, project: panel.querySelector('#jb-proj').value || undefined, tool: panel.querySelector('#jb-tool').value } }); toast('Started'); draw(); } catch (err) { fail(err); }
      };
      const act = (sel, fn) => panel.querySelectorAll(sel).forEach((b) => (b.onclick = async () => { try { await fn(b); draw(); } catch (e) { fail(e); } }));
      act('[data-jb-ok]', (b) => api('/api/jobs/approve', { method: 'POST', body: { id: b.dataset.jbOk } }));
      act('[data-jb-no]', (b) => api('/api/jobs/approve', { method: 'POST', body: { id: b.dataset.jbNo, reject: true } }));
      act('[data-jb-stop]', (b) => api('/api/jobs/stop', { method: 'POST', body: { id: b.dataset.jbStop } }));
      act('[data-jb-retry]', (b) => { const j = d.jobs.find((x) => x.id === b.dataset.jbRetry); return api('/api/jobs', { method: 'POST', body: { prompt: j.prompt, device: j.device, project: j.project, task: j.task, tool: j.tool, model: j.model } }); });
    };
    draw();
    const t = setInterval(() => { if (!document.body.contains(panel)) return clearInterval(t); if (d && d.jobs.some((j) => ['queued', 'running', 'needs-approval'].includes(j.status))) draw(); }, 4000);
  }

  const wrap = (name, after) => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = async function (...a) { const r = await orig.apply(this, a); try { await after(); } catch (e) { console.warn(name, e); } return r; };
  };
  wrap('renderSettings', async () => { if (S.route[0] !== 'settings') return; let local = false; try { local = !!(await api('/api/settings')).local; } catch { /* phone view */ } await devicesPanel(document.querySelector('.settings-grid'), local); });
  wrap('renderAgents', async () => { if (S.route[0] !== 'agents') return; await jobsPanel(document.querySelector('#main') || document.querySelector('main')); });
})();

// ---------- Home: guided "Get set up" checklist (shown on the main computer until everything is done) ----------
(() => {
  const orig = window.renderHome;
  if (typeof orig !== 'function') return;
  window.renderHome = async function (...a) {
    const r = await orig.apply(this, a);
    try {
      if (S.route[0] !== 'home' || document.getElementById('gs-panel')) return r;
      let hidden = false; try { hidden = localStorage.getItem('cortex.setupHidden') === '1'; } catch { /* private mode */ }
      const [ag, st, dv] = await Promise.all([api('/api/agents'), api('/api/settings'), api('/api/devices')]);
      if (!st.local) return r;
      const phones = dv.devices.filter((x) => x.kind === 'phone').length;
      const comps = dv.devices.filter((x) => x.kind === 'computer').length;
      const steps = [
        { done: !!(ag.ready && ag.ready.tool), title: 'Install Claude Code or Codex', help: 'Cortex starts these agents for you.', go: '#/agents', btn: 'Check' },
        { done: !!(ag.ready && ag.ready.enabled && ag.ready.folders), title: 'Let Cortex start agents in a folder', help: 'Choose the folder where your code lives.', go: '#/settings', btn: 'Set up' },
        { done: !!(st.remote && st.remote.enabled), title: 'Turn on phone access', help: 'Watch and command agents from your phone.', go: '#/settings', btn: 'Turn on' },
        { done: phones > 0, title: 'Pair your phone', help: 'Scan a QR code: about a minute.', go: '#/settings', btn: 'Pair', optional: true },
        { done: comps > 0, title: 'Add your other computer (optional)', help: 'Run agents on it from here or your phone.', go: '#/settings', btn: 'Add', optional: true },
      ];
      const need = steps.filter((s) => !s.done && !s.optional).length;
      const doneN = steps.filter((s) => s.done).length;
      if ((hidden && !need) || doneN === steps.length) return r;
      const p = document.createElement('div');
      p.className = 'panel'; p.id = 'gs-panel'; p.style.marginBottom = '16px';
      p.innerHTML = `<div class="row" style="align-items:center"><h3 style="margin:0;flex:1">Get set up <span class="small muted">· ${doneN} of ${steps.length} done</span></h3>${need ? '' : '<button class="btn sm ghost" id="gs-hide">Hide</button>'}</div>
        <div class="meter" style="margin:10px 0 6px"><span style="width:${Math.round((doneN / steps.length) * 100)}%"></span></div>
        ${steps.map((s) => `<div class="dv" style="margin-top:8px"><span class="dot ${s.done ? 'on' : ''}"></span><div class="grow"><b>${esc(s.title)}</b><span class="small muted">${s.done ? 'Done' : esc(s.help)}</span></div>${s.done ? '' : `<a class="btn sm ${s.optional ? '' : 'primary'}" href="${s.go}">${esc(s.btn)}</a>`}</div>`).join('')}`;
      if (document.getElementById('gs-panel') || S.route[0] !== 'home') return r; // a second render finished first
      const head = document.querySelector('#main .page-head');
      if (head && head.nextSibling) head.parentNode.insertBefore(p, head.nextSibling); else document.querySelector('#main').prepend(p);
      const h = p.querySelector('#gs-hide'); if (h) h.onclick = () => { try { localStorage.setItem('cortex.setupHidden', '1'); } catch { /* ignore */ } p.remove(); };
    } catch (e) { console.warn('setup checklist', e); }
    return r;
  };
})();
