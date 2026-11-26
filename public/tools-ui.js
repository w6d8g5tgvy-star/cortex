// Cortex 2.3: "AI tools & connections" (checklist #15) in Settings on the main computer. See every MCP server your AI
// apps use, check it works, and share one you set up in one app with the others. Secret values are never shown.
(() => {
  const st = document.createElement('style');
  st.textContent = `.tm-tbl{width:100%;border-collapse:collapse;font-size:12.5px}.tm-tbl th,.tm-tbl td{text-align:left;padding:6px 6px;border-bottom:1px solid var(--edge,rgba(255,255,255,.06));vertical-align:top}
  .tm-y{color:#3ddc97}.tm-n{color:var(--text-3,#667)}.tm-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--edge,rgba(255,255,255,.14));margin:1px 3px 1px 0}
  .tm-res{font-size:12px;margin-top:4px}.tm-res.ok{color:#3ddc97}.tm-res.bad{color:#ff7a90}
  @media (max-width:700px){.tm-tbl .hide-sm{display:none}}`;
  document.head.appendChild(st);

  async function panel() {
    if (S.route[0] !== 'settings' || !S.local) return;
    const grid = document.querySelector('.settings-grid'); if (!grid || grid.querySelector('#tm-set')) return;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'tm-set'; p.style.gridColumn = '1 / -1'; grid.appendChild(p);
    draw(p);
  }
  async function draw(p) {
    let d; try { d = await api('/api/tools'); } catch (e) { p.innerHTML = `<h3>AI tools &amp; connections</h3><div class="small muted">${esc(e.message)}</div>`; return; }
    const apps = Object.entries(d.apps); const installed = apps.filter(([, a]) => a.installed);
    const servers = Object.values(d.servers).sort((a, b) => a.name.localeCompare(b.name));
    p.innerHTML = `<h3>AI tools &amp; connections</h3>
      <p class="small muted" style="margin:2px 0 8px">The MCP servers (tools) each AI app on this computer can use. Set a tool up once, then share it with your other apps here. Keys and tokens stay in each app's own settings: Cortex never stores or shows them.</p>
      <div class="small" style="margin-bottom:8px">${apps.map(([, a]) => `<span class="tm-chip">${a.installed ? '<span class="tm-y">●</span>' : '<span class="tm-n">○</span>'} ${esc(a.label)}${a.installed ? ` · ${a.count}` : ' · not installed'}${a.error ? ' · <span style="color:#ff7a90">config unreadable</span>' : ''}</span>`).join('')}</div>
      ${servers.length ? `<table class="tm-tbl"><tr><th>Tool</th>${installed.map(([, a]) => `<th class="hide-sm">${esc(a.label)}</th>`).join('')}<th>Actions</th></tr>
      ${servers.map((s) => { const first = Object.keys(s.in)[0]; const info = s.in[first];
        return `<tr><td><b>${esc(s.name)}</b><div class="small muted">${info.kind === 'http' ? esc(info.url || '') : esc([info.command, ...(info.args || [])].join(' ').slice(0, 80))}</div>${info.env.length ? `<div class="small muted">needs: ${info.env.map(esc).join(', ')} (hidden)</div>` : ''}${s.variants > 1 ? '<div class="small" style="color:#ffc35c">Set up differently in different apps</div>' : ''}<div class="tm-res" id="tm-r-${esc(s.name)}"></div></td>
          ${installed.map(([k]) => `<td class="hide-sm">${s.in[k] ? `<span class="tm-y" title="${s.in[k].managed ? 'Added by Cortex' : 'Set up in this app'}">✓</span>${s.in[k].managed ? ' <a href="#" class="small" data-tm-un="' + esc(s.name) + '" data-app="' + k + '">remove</a>' : ''}` : '<span class="tm-n">—</span>'}</td>`).join('')}
          <td><button class="btn sm ghost" data-tm-check="${esc(s.name)}" data-app="${first}">Check</button>${s.canShareTo.length ? ` <button class="btn sm" data-tm-share="${esc(s.name)}" data-from="${first}" data-to="${s.canShareTo.join(',')}">Share with ${s.canShareTo.map((k) => esc(d.apps[k].label)).join(', ')}</button>` : ''}</td></tr>`; }).join('')}</table>` : '<div class="small muted">No MCP servers found in your AI apps yet.</div>'}
      <details style="margin-top:10px"><summary class="small">Local tools and API keys</summary><div class="small" style="margin-top:6px">${d.local.tools.map((t) => `<span class="tm-chip">${t.found ? '<span class="tm-y">●</span>' : '<span class="tm-n">○</span>'} ${esc(t.label)}</span>`).join('')}</div>
        <div class="small" style="margin-top:6px">${d.local.apiKeys.map((k) => `<span class="tm-chip">${k.set ? '<span class="tm-y">set</span>' : '<span class="tm-n">not set</span>'} ${esc(k.name)}</span>`).join('')}</div><div class="small muted" style="margin-top:4px">${esc(d.local.note)}</div></details>`;
    p.querySelectorAll('[data-tm-check]').forEach((b) => (b.onclick = async () => {
      const out = p.querySelector('#tm-r-' + CSS.escape(b.dataset.tmCheck)); out.className = 'tm-res'; out.textContent = 'Checking…'; b.disabled = true;
      try { const r = await api('/api/tools', { method: 'POST', body: { action: 'check', name: b.dataset.tmCheck, app: b.dataset.app } }); out.className = 'tm-res ' + (r.ok ? 'ok' : 'bad'); out.textContent = r.ok ? `✓ Working${r.tools !== undefined ? `: ${r.tools} tools` : ''}${r.server ? ` (${r.server})` : ''} · ${r.ms} ms` : `✗ ${r.error}`; } catch (e) { out.className = 'tm-res bad'; out.textContent = e.message; } finally { b.disabled = false; }
    }));
    p.querySelectorAll('[data-tm-share]').forEach((b) => (b.onclick = async () => {
      const to = b.dataset.to.split(','); if (!confirm(`Add "${b.dataset.tmShare}" to ${to.map((k) => d.apps[k].label).join(', ')}? Its settings (including any keys) are copied from ${d.apps[b.dataset.from].label}. A backup of each config file is kept.`)) return;
      try { const r = await api('/api/tools', { method: 'POST', body: { action: 'share', name: b.dataset.tmShare, from: b.dataset.from, to } }); toast(r.results.map((x) => `${d.apps[x.app] ? d.apps[x.app].label : x.app}: ${x.msg}`).join(' · ')); draw(p); } catch (e) { fail(e); }
    }));
    p.querySelectorAll('[data-tm-un]').forEach((a) => (a.onclick = async (e) => {
      e.preventDefault(); if (!confirm(`Remove "${a.dataset.tmUn}" from ${d.apps[a.dataset.app].label}? (Cortex added it there.)`)) return;
      try { await api('/api/tools', { method: 'POST', body: { action: 'unshare', name: a.dataset.tmUn, app: a.dataset.app } }); toast('Removed'); draw(p); } catch (er) { fail(er); }
    }));
  }
  const wrap = (name, after) => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); Promise.resolve(r).then(() => after()).catch((e) => console.warn(name, e)); return r; }; };
  wrap('renderSettings', panel);
})();
