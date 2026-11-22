// SmartSave screens: per-project autosave panel (status, Save now, privacy preview, timeline, restore, continue on
// another computer) and Settings → SmartSave (backup destinations, recovery key). Always separates "saved on this
// computer" from "safely copied off it".
(() => {
  const css = `
  #ss-panel h3 .small{display:block;text-transform:none;letter-spacing:0;font-weight:400;margin-top:3px}
  .ss-status{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
  .ss-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12.5px;border:1px solid var(--edge-2,rgba(255,255,255,.15))}
  .ss-pill .d{width:8px;height:8px;border-radius:50%;background:#777}
  .ss-pill.ok .d{background:#3ee08f;box-shadow:0 0 8px #3ee08f}.ss-pill.warn .d{background:#ffc35c}.ss-pill.bad .d{background:#ff6b6b}.ss-pill.local .d{background:#47e3ff}
  .ss-tl{display:grid;gap:6px;margin-top:10px;max-height:340px;overflow:auto}
  .ss-snap{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.08))}
  .ss-snap .grow{flex:1;min-width:0}.ss-snap .grow b{font-size:13px}
  .ss-box{margin-top:10px;padding:12px;border-radius:12px;border:1px solid rgba(124,92,255,.4);background:rgba(124,92,255,.05)}
  .ss-key{font:600 12px ui-monospace,monospace;word-break:break-all;padding:8px;border-radius:8px;background:rgba(0,0,0,.3)}
  @media (max-width:640px){.ss-snap{flex-wrap:wrap}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const ago = (iso) => (iso ? timeAgo(iso) : 'never');
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const STATE = { verified: ['ok', 'Backed up'], queued: ['warn', 'Uploading…'], failed: ['bad', 'Upload failing'], stale: ['warn', 'Backup behind'], 'not-yet': ['warn', 'Not backed up yet'] };

  function statusPills(p) {
    const pills = [];
    pills.push(`<span class="ss-pill local"><span class="d"></span>Saved on this computer ${p.lastLocal ? ago(p.lastLocal.time) : '— not yet'}</span>`);
    if (!p.targets.length) pills.push('<span class="ss-pill bad"><span class="d"></span>Only on this computer: add a backup destination in Settings → SmartSave</span>');
    for (const t of p.targets) { const [cls, label] = STATE[t.state] || ['warn', t.state]; pills.push(`<span class="ss-pill ${cls}" title="${esc(t.error || '')}"><span class="d"></span>${esc(t.name)}: ${label}${t.lastVerified ? ' · ' + ago(t.lastVerified) : ''}</span>`); }
    return pills.join('');
  }

  // ---------------- project page ----------------
  let kept = null; // the page re-renders often (agents working): keep the same panel so open forms/results survive
  async function projectPanel(slug) {
    const main = document.querySelector('#main');
    if (!main || main.querySelector('#ss-panel')) return;
    const reuse = kept && kept.slug === slug;
    const panel = reuse ? kept.node : document.createElement('div');
    if (!reuse) { panel.className = 'panel'; panel.id = 'ss-panel'; panel.style.margin = '16px 0'; panel.innerHTML = '<div class="ss-main"></div><div id="ss-out"></div>'; kept = { slug, node: panel }; }
    const tiles = main.querySelector('.tiles');
    if (tiles && tiles.nextSibling) tiles.parentNode.insertBefore(panel, tiles.nextSibling); else main.appendChild(panel);
    const head = panel.querySelector('.ss-main');
    const draw = async () => {
      let s; try { s = await api('/api/smartsave/status'); } catch (e) { head.innerHTML = `<h3>SmartSave</h3><div class="muted small">${esc(e.message)}</div>`; return; }
      const p = s.projects[slug];
      const pr = proj(slug) || {};
      const on = !!(s.enabled && p && p.enabled);
      const local = !!(await api('/api/settings').catch(() => ({}))).local;
      head.innerHTML = `<div class="row" style="align-items:center"><h3 style="margin:0;flex:1">💾 SmartSave <span class="small muted">Automatic saves of this project's files</span></h3>
          ${local ? `<span class="seg"><button type="button" class="${on ? 'on' : ''}" data-ss-on="1">On</button><button type="button" class="${on ? '' : 'on'}" data-ss-on="0">Off</button></span>` : ''}</div>
        ${on ? `<div class="ss-status">${statusPills(p)}</div>
          <div class="small muted">${p.lastProtected ? `Last safe copy away from this computer: <b>${new Date(p.lastProtected).toLocaleString()}</b>. If this computer turns off, that version can be restored on another one.` : 'No copy away from this computer yet.'} Saves happen after changes settle (about ${s.debounceSec || 15} s), at least every ${Math.max(1, Math.round((s.intervalSec || 120) / 60))} minute${Math.round((s.intervalSec || 120) / 60) === 1 ? '' : 's'} while files change, before context compaction or token limits, and before updates. No AI is used.</div>
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn sm primary" id="ss-now">Save now</button><button class="btn sm" id="ss-prev">What gets saved?</button><button class="btn sm" id="ss-tl">Versions &amp; restore</button></div>`
        : `<p class="small muted" style="margin:6px 0 0">Keeps every change to <b>${esc((p && p.root) || pr.folder || 'this project\'s folder')}</b>, including uncommitted code, so you can get it back on this or another computer if something goes wrong. Secrets like .env files and keys are never saved.${!(pr.folder || (p && p.root)) ? ' First set the project folder (Edit → folder).' : ''}</p>`}`;
      head.querySelectorAll('[data-ss-on]').forEach((b) => (b.onclick = async () => {
        try {
          if (b.dataset.ssOn === '1' && !s.enabled) await api('/api/smartsave/settings', { method: 'POST', body: { enabled: true } });
          await api('/api/smartsave/settings', { method: 'POST', body: { project: { id: slug, enabled: b.dataset.ssOn === '1' } } });
          toast(b.dataset.ssOn === '1' ? 'SmartSave is on: first save in a few seconds' : 'SmartSave off for this project');
          setTimeout(draw, 2500);
        } catch (e) { fail(e); }
      }));
      const out = panel.querySelector('#ss-out');
      if (!on) { out.innerHTML = ''; return; }
      panel.querySelector('#ss-now').onclick = async () => { try { const r = await api('/api/smartsave/save', { method: 'POST', body: { project: slug } }); toast(`Saved: ${r.files} files (${(r.added || 0) + (r.changed || 0)} new or changed)`); draw(); } catch (e) { fail(e); } };
      panel.querySelector('#ss-prev').onclick = async () => {
        try {
          const v = await api('/api/smartsave/preview?project=' + encodeURIComponent(slug));
          out.innerHTML = `<div class="ss-box"><b>${v.included} files (${kb(v.bytes)}) are saved</b> from ${esc(v.root)}<div class="small muted" style="margin:4px 0">${v.sample.slice(0, 12).map(esc).join(' · ')}${v.included > 12 ? ' …' : ''}</div><b>${v.skippedCount} skipped</b><div class="small" style="margin-top:4px">${v.skipped.slice(0, 15).map((x) => `${esc(x.path)} <span class="muted">(${esc(x.reason)})</span>`).join('<br>') || 'none'}</div><div class="small muted" style="margin-top:6px">Also skipped automatically: node_modules, build output, caches, and anything in .gitignore.</div></div>`;
        } catch (e) { fail(e); }
      };
      panel.querySelector('#ss-tl').onclick = async () => {
        try {
          const [loc, jobs] = await Promise.all([api('/api/smartsave/snapshots?project=' + encodeURIComponent(slug)), api('/api/jobs').catch(() => ({ computers: [] }))]);
          const others = (jobs.computers || []).filter((c) => c.id !== 'local' && c.online);
          out.innerHTML = `<div class="ss-tl">${loc.snapshots.map((x) => `<div class="ss-snap"><div class="grow"><b>${new Date(x.time).toLocaleString()}</b> <span class="small muted">· ${esc(x.reason || '')} · ${x.files} files${x.deleted ? ` · ${x.deleted} deleted` : ''}${x.device ? ' · ' + esc(x.device) : ''}</span>${x.context && x.context.step ? `<div class="small muted">${esc(x.context.step)}</div>` : ''}</div>${local ? `<button class="btn sm" data-ss-restore="${esc(x.id)}">Restore…</button>` : ''}${others.map((c) => `<button class="btn sm" data-ss-cont="${esc(x.id)}" data-dev="${esc(c.id)}">Continue on ${esc(c.name)}</button>`).join('')}</div>`).join('') || '<div class="small muted">No versions yet.</div>'}</div>`;
          out.querySelectorAll('[data-ss-restore]').forEach((b) => (b.onclick = () => restoreFlow(slug, b.dataset.ssRestore, out)));
          out.querySelectorAll('[data-ss-cont]').forEach((b) => (b.onclick = async () => { try { await api('/api/jobs', { method: 'POST', body: { device: b.dataset.dev, project: slug, restore: { id: b.dataset.ssCont } } }); toast('Sent: that computer restores this version and continues the work'); } catch (e) { fail(e); } }));
        } catch (e) { fail(e); }
      };
    };
    draw();
  }

  async function restoreFlow(slug, id, out) {
    try {
      const pv = await api('/api/smartsave/restore', { method: 'POST', body: { project: slug, id, preview: true } });
      out.innerHTML = `<div class="ss-box"><b>Restore the version from ${new Date(pv.snapshot.time).toLocaleString()}</b><div class="small" style="margin:6px 0">Into a <b>new folder</b>: <code>${esc(pv.dest)}</code><br>${pv.add.length} files will be created${pv.change.length ? `, ${pv.change.length} differ (kept as they are unless you allow overwriting)` : ''}${pv.same.length ? `, ${pv.same.length} already match` : ''}. Your current project folder is not touched.</div>
        <div class="field"><label>Restore into</label><input class="input" id="ss-dest" value="${esc(pv.dest)}"></div>
        <label class="small"><input type="checkbox" id="ss-ow"> Overwrite files that differ in that folder</label>
        <div class="row" style="gap:8px;margin-top:8px"><button class="btn primary sm" id="ss-go">Restore</button><button class="btn sm" id="ss-cancel">Cancel</button></div><div id="ss-res" class="small" style="margin-top:6px"></div></div>`;
      out.querySelector('#ss-cancel').onclick = () => { out.innerHTML = ''; };
      out.querySelector('#ss-go').onclick = async () => {
        try {
          const r = await api('/api/smartsave/restore', { method: 'POST', body: { project: slug, id, dest: out.querySelector('#ss-dest').value, overwrite: out.querySelector('#ss-ow').checked } });
          out.querySelector('#ss-res').innerHTML = `✓ Restored into <code>${esc(r.dest)}</code>: ${r.written} written, ${r.same} already matched, ${r.verified} verified${r.conflicts.length ? `, <b>${r.conflicts.length} not overwritten</b>` : ''}${r.failed.length ? `, <span style="color:var(--bad)">${r.failed.length} failed</span>` : ''}. Open <code>CORTEX-RESTORE.md</code> there to see where the work was.`;
        } catch (e) { fail(e); }
      };
    } catch (e) { fail(e); }
  }

  // ---------------- Settings → SmartSave ----------------
  async function settingsPanel(grid) {
    if (!grid || grid.querySelector('#ss-set')) return;
    const panel = document.createElement('div');
    panel.className = 'panel'; panel.id = 'ss-set';
    grid.prepend(panel);
    const draw = async () => {
      let s; let local = false;
      try { s = await api('/api/smartsave/status'); local = !!(await api('/api/settings')).local; } catch (e) { panel.innerHTML = `<h3>SmartSave</h3><div class="muted small">${esc(e.message)}</div>`; return; }
      const projects = Object.entries(s.projects);
      const replicas = [...new Set(projects.flatMap(([, p]) => p.targets.filter((t) => t.type === 'paired').map((t) => t.name)))];
      panel.innerHTML = `<h3>💾 SmartSave</h3><p class="small muted" style="margin-top:0">Automatic, free (no AI) saves of your project files, copied away from this computer so another computer or agent can pick up unfinished work. Turn it on per project on the project's page.</p>
        <div class="small"><b>${projects.filter(([, p]) => p.enabled).length}</b> project${projects.filter(([, p]) => p.enabled).length === 1 ? '' : 's'} protected${s.queue ? ` · ${s.queue} upload${s.queue === 1 ? '' : 's'} waiting` : ''}</div>
        <div style="margin-top:10px"><b class="small">Backup destinations</b> <span class="small muted">(copies away from this computer, encrypted)</span></div>
        <div class="dv-list">${s.targets.map((t) => `<div class="dv"><span class="dot ${t.error ? '' : t.lastVerified ? 'on' : ''}"></span><div class="grow"><b>${esc(t.name)}</b><span class="small muted">${t.type === 's3' ? 'Cloud storage' : 'Folder'} · ${t.error ? 'error: ' + esc(t.error) : t.lastVerified ? 'last verified ' + ago(t.lastVerified) : 'nothing uploaded yet'}${t.bytesSent ? ' · ' + kb(t.bytesSent) + ' sent' : ''}</span></div>${local ? `<button class="btn sm danger" data-ss-del="${esc(t.id)}">Remove</button>` : ''}</div>`).join('')}
          ${replicas.map((n) => `<div class="dv"><span class="dot on"></span><div class="grow"><b>${esc(n)}</b><span class="small muted">Paired computer · keeps a copy automatically</span></div></div>`).join('')}
          ${!s.targets.length && !replicas.length ? '<div class="small" style="color:var(--warn)">No destination yet: saves stay on this computer only. Add one below, or pair your other computer (Settings → Devices → Add a computer) and it keeps a copy automatically.</div>' : ''}</div>
        ${local ? `<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sm primary" data-ss-add="folder">Add a folder</button><button class="btn sm" data-ss-add="s3">Add cloud storage</button><button class="btn sm ghost" id="ss-key">Show recovery key</button></div><div id="ss-form"></div>` : ''}`;
      panel.querySelectorAll('[data-ss-del]').forEach((b) => (b.onclick = async () => { if (!confirm('Remove this backup destination? Copies already there are not deleted.')) return; try { await api('/api/smartsave/targets?id=' + encodeURIComponent(b.dataset.ssDel), { method: 'DELETE' }); draw(); } catch (e) { fail(e); } }));
      if (!local) return;
      const form = panel.querySelector('#ss-form');
      panel.querySelector('#ss-key').onclick = async () => { try { const k = await api('/api/smartsave/recovery-key'); form.innerHTML = `<div class="ss-box"><b>Recovery key</b><div class="small muted" style="margin:4px 0">Backups are encrypted with this key. Paired computers receive it automatically. To restore from a folder or cloud storage on a brand-new computer you need it: keep it in your password manager. Never paste it into a chat.</div><div class="ss-key">${esc(k.key)}</div></div>`; } catch (e) { fail(e); } };
      panel.querySelectorAll('[data-ss-add]').forEach((b) => (b.onclick = () => {
        const s3 = b.dataset.ssAdd === 's3';
        form.innerHTML = `<form class="ss-box" id="ss-f">${s3 ? `<b>Cloud storage (S3-compatible)</b><div class="small muted">Your own bucket on Cloudflare R2, Backblaze B2, AWS S3 or similar. Cortex never creates a paid account for you. Use a key limited to this one bucket.</div>
          <div class="field"><label>Endpoint</label><input class="input" name="endpoint" placeholder="https://<account>.r2.cloudflarestorage.com"></div><div class="grid2"><div class="field"><label>Bucket</label><input class="input" name="bucket"></div><div class="field"><label>Region</label><input class="input" name="region" value="auto"></div><div class="field"><label>Access key ID</label><input class="input" name="accessKeyId"></div><div class="field"><label>Secret access key</label><input class="input" type="password" name="secretAccessKey"></div></div>`
          : `<b>Backup folder</b><div class="small muted">Best: a folder synced by OneDrive, Google Drive or Dropbox, or another drive (USB/NAS). Cortex confirms the copy reached the folder; the sync app takes it to the cloud.</div><div class="field"><label>Folder</label><input class="input" name="dir" placeholder="C:\\Users\\you\\OneDrive\\Cortex backups"></div>`}
          <div class="field"><label>Name</label><input class="input" name="name" value="${s3 ? 'Cloud storage' : 'Backup folder'}"></div><div class="row" style="gap:8px"><button class="btn primary sm">Test &amp; add</button><button type="button" class="btn sm" id="ss-fx">Cancel</button></div></form>`;
        form.querySelector('#ss-fx').onclick = () => { form.innerHTML = ''; };
        form.querySelector('#ss-f').onsubmit = async (e) => {
          e.preventDefault();
          const body = Object.fromEntries(new FormData(e.target).entries()); body.type = s3 ? 's3' : 'folder';
          try { await api('/api/smartsave/targets', { method: 'POST', body }); toast('Added: uploading your latest saves'); draw(); } catch (err) { fail(err); }
        };
      }));
    };
    draw();
  }

  const wrap = (name, after) => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); Promise.resolve(r).then(() => after()).catch((e) => console.warn(name, e)); return r; }; };
  wrap('renderProjects', () => { if (S.route[0] === 'projects' && S.route[1]) return projectPanel(S.route[1]); });
  wrap('renderSettings', () => { if (S.route[0] === 'settings') return settingsPanel(document.querySelector('.settings-grid')); });
})();
