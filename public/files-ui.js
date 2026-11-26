// Cortex 2.3: built-in file editor (checklist #35). Opens from a project page: file list + search, text editor with
// autosave, Markdown/code preview, version history with comparisons and restore. Not an IDE, on purpose.
(() => {
  const css = `
  .fe-ov{position:fixed;inset:0;z-index:80;background:rgba(3,5,14,.82);backdrop-filter:blur(6px);display:flex;padding:18px}
  .fe-box{flex:1;display:grid;grid-template-columns:270px 1fr;gap:12px;min-height:0;border-radius:16px;padding:12px;background:var(--panel,#0e1022);border:1px solid var(--edge-2,rgba(255,255,255,.15))}
  .fe-side{display:flex;flex-direction:column;min-height:0;gap:8px}
  .fe-side input{width:100%;padding:8px 11px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.1));background:rgba(6,9,22,.45);color:var(--text,#eef)}
  .fe-files{overflow:auto;flex:1;font-size:12.5px}
  .fe-f{padding:4px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fe-f:hover{background:rgba(255,255,255,.05)}.fe-f.on{background:rgba(124,92,255,.18)}
  .fe-f .d{color:var(--text-3,#889)}
  .fe-hit{font-size:11.5px;color:var(--text-3,#889);padding-left:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fe-main{display:flex;flex-direction:column;min-height:0;gap:8px}
  .fe-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .fe-ed{flex:1;display:flex;min-height:0;border-radius:12px;border:1px solid var(--edge,rgba(255,255,255,.1));background:rgba(6,9,22,.55);overflow:hidden}
  .fe-gut{padding:10px 8px;text-align:right;color:var(--text-3,#667);font:12.5px/1.6 ui-monospace,Menlo,Consolas,monospace;user-select:none;overflow:hidden;min-width:44px;white-space:pre}
  .fe-ta{flex:1;resize:none;border:0;outline:0;background:transparent;color:var(--text,#eef);padding:10px 12px;font:12.5px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre;overflow:auto;tab-size:2}
  .fe-prev{flex:1;overflow:auto;padding:12px 16px}
  .fe-prev pre{white-space:pre-wrap;font:12.5px/1.6 ui-monospace,Menlo,Consolas,monospace}
  .fe-diff{flex:1;overflow:auto;font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;padding:8px}
  .fe-diff div{white-space:pre-wrap;padding:0 6px}.fe-diff .a{background:rgba(61,220,151,.13);color:#9ff0c9}.fe-diff .r{background:rgba(255,93,122,.13);color:#ffb3c0;text-decoration:line-through}
  .fe-ver{padding:6px 8px;border-radius:8px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:5px;font-size:12px}
  .fe-st{font-size:12px;color:var(--text-3,#889)}.fe-st.bad{color:#ff7a90}.fe-st.ok{color:#3ddc97}
  @media (max-width:820px){.fe-ov{padding:0}.fe-box{grid-template-columns:1fr;border-radius:0;grid-template-rows:auto 1fr}.fe-side{max-height:34vh}.fe-gut{display:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const F = { project: null, files: [], canEdit: false, cur: null, text: '', saved: '', mtime: null, mode: 'edit', timer: null, ov: null, saving: false };
  const isMd = (p) => /\.(md|markdown)$/i.test(p || '');

  async function open(project, file) {
    F.project = project; F.cur = null; F.mode = 'edit';
    let d; try { d = await api('/api/files?project=' + encodeURIComponent(project)); } catch (e) { return fail(e); }
    F.files = d.files; F.canEdit = d.canEdit;
    F.ov = document.createElement('div'); F.ov.className = 'fe-ov'; F.ov.id = 'fe-ov';
    F.ov.innerHTML = `<div class="fe-box"><div class="fe-side"><div class="fe-bar"><b style="flex:1">${esc(d.folder)}</b><button class="btn sm ghost" id="fe-close" title="Close (Esc)">✕</button></div>
      <input id="fe-filter" placeholder="Filter, or Enter to search inside" title="Type to filter file names; press Enter to search inside files">${F.canEdit ? '<button class="btn sm ghost" id="fe-newf">+ New file</button>' : '<div class="small muted">Read-only on this device.</div>'}
      <div class="fe-files" id="fe-files"></div>${d.truncated ? '<div class="small muted">Showing the first 3000 files.</div>' : ''}</div>
      <div class="fe-main" id="fe-main"><div class="small muted" style="margin:auto">Pick a file on the left.</div></div></div>`;
    document.body.appendChild(F.ov);
    F.ov.querySelector('#fe-close').onclick = close;
    const filt = F.ov.querySelector('#fe-filter');
    filt.oninput = () => drawFiles(filt.value);
    filt.onkeydown = async (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (filt.value.trim().length < 2) return; try { const r = await api(`/api/files?project=${encodeURIComponent(F.project)}&op=search&q=${encodeURIComponent(filt.value.trim())}`); drawSearch(r); } catch (er) { fail(er); } };
    const nf = F.ov.querySelector('#fe-newf'); if (nf) nf.onclick = async () => { const p = prompt('New file path (inside the project), e.g. notes/plan.md'); if (!p) return; try { await api('/api/files', { method: 'POST', body: { project: F.project, action: 'create', path: p, text: '' } }); await refreshList(); openFile(p.replace(/\\/g, '/').replace(/^\/+/, '')); } catch (e) { fail(e); } };
    document.addEventListener('keydown', keys);
    drawFiles('');
    if (file) openFile(file);
  }
  async function refreshList() { const d = await api('/api/files?project=' + encodeURIComponent(F.project)); F.files = d.files; drawFiles(F.ov.querySelector('#fe-filter').value); }
  async function close() {
    if (F.text !== F.saved && F.canEdit && F.cur) { await save(); if (F.text !== F.saved && !confirm('Your last changes couldn\'t be saved. Close anyway?')) return; }
    clearTimeout(F.timer); document.removeEventListener('keydown', keys); if (F.ov) F.ov.remove(); F.ov = null;
  }
  function keys(e) {
    if (!F.ov) return;
    if (e.key === 'Escape' && !document.querySelector('.fe-ov input:focus')) close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  }
  function drawFiles(filter) {
    const box = F.ov.querySelector('#fe-files'); const f = String(filter || '').toLowerCase();
    const list = F.files.filter((x) => !f || x.path.toLowerCase().includes(f)).slice(0, 800);
    box.innerHTML = list.map((x) => { const i = x.path.lastIndexOf('/'); return `<div class="fe-f ${F.cur === x.path ? 'on' : ''}" data-f="${esc(x.path)}" title="${esc(x.path)}"><span class="d">${esc(i >= 0 ? x.path.slice(0, i + 1) : '')}</span>${esc(x.path.slice(i + 1))}</div>`; }).join('') || '<div class="small muted">No matching files.</div>';
    box.querySelectorAll('[data-f]').forEach((el) => (el.onclick = () => openFile(el.dataset.f)));
  }
  function drawSearch(r) {
    const box = F.ov.querySelector('#fe-files');
    box.innerHTML = `<div class="small muted" style="margin-bottom:6px">${r.results.length} file(s)${r.truncated ? ' (first 200)' : ''} · <a href="#" id="fe-clear">show all files</a></div>` + r.results.map((x) => `<div class="fe-f" data-f="${esc(x.path)}">${esc(x.path)}</div>${x.hits.map((h) => `<div class="fe-hit" data-f="${esc(x.path)}" data-l="${h.line}">${h.line}: ${esc(h.text)}</div>`).join('')}`).join('');
    box.querySelector('#fe-clear').onclick = (e) => { e.preventDefault(); drawFiles(''); };
    box.querySelectorAll('[data-f]').forEach((el) => (el.onclick = () => openFile(el.dataset.f, Number(el.dataset.l) || 0)));
  }

  async function openFile(p, line = 0) {
    if (F.cur && F.text !== F.saved && F.canEdit) await save();
    let d; try { d = await api(`/api/files?project=${encodeURIComponent(F.project)}&op=read&path=${encodeURIComponent(p)}`); } catch (e) { return fail(e); }
    F.cur = d.path; F.text = d.text; F.saved = d.text; F.mtime = d.mtimeMs; F.canEdit = d.canEdit; F.mode = isMd(p) && !F.canEdit ? 'preview' : 'edit';
    drawFiles(F.ov.querySelector('#fe-filter').value); drawMain();
    if (line && F.mode === 'edit') { const ta = F.ov.querySelector('.fe-ta'); const pos = F.text.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0); ta.focus(); ta.setSelectionRange(pos, pos); ta.scrollTop = Math.max(0, (line - 5) * 20); syncGutter(); }
  }
  function status(t, cls = '') { const el = F.ov && F.ov.querySelector('#fe-st'); if (el) { el.textContent = t; el.className = 'fe-st ' + cls; } }

  function drawMain() {
    const main = F.ov.querySelector('#fe-main');
    main.innerHTML = `<div class="fe-bar"><b style="word-break:break-all">${esc(F.cur)}</b><span class="fe-st" id="fe-st">${F.canEdit ? 'Saved' : 'Read-only'}</span><span style="flex:1"></span>
      <button class="btn sm ${F.mode === 'edit' ? '' : 'ghost'}" data-m="edit">${F.canEdit ? 'Edit' : 'Text'}</button><button class="btn sm ${F.mode === 'preview' ? '' : 'ghost'}" data-m="preview">Preview</button><button class="btn sm ${F.mode === 'history' ? '' : 'ghost'}" data-m="history">History</button></div><div class="fe-ed" id="fe-body"></div>`;
    main.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { F.mode = b.dataset.m; drawMain(); }));
    const body = main.querySelector('#fe-body');
    if (F.mode === 'edit') {
      body.innerHTML = `<div class="fe-gut" id="fe-gut"></div><textarea class="fe-ta" spellcheck="false" ${F.canEdit ? '' : 'readonly'}></textarea>`;
      const ta = body.querySelector('.fe-ta'); ta.value = F.text; syncGutter();
      ta.onscroll = syncGutter;
      ta.oninput = () => { F.text = ta.value; syncGutter(); if (!F.canEdit) return; status('Unsaved changes…'); clearTimeout(F.timer); F.timer = setTimeout(save, 1500); };
      ta.onkeydown = (e) => { if (e.key === 'Tab' && F.canEdit) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.oninput(); } };
      if (F.text !== F.saved) status('Unsaved changes…');
    } else if (F.mode === 'preview') {
      body.innerHTML = `<div class="fe-prev">${isMd(F.cur) ? `<div class="md">${md(F.text)}</div>` : `<pre>${F.text.split('\n').map((l, i) => `<span style="color:var(--text-3,#667);user-select:none">${String(i + 1).padStart(4)}  </span>${esc(l)}`).join('\n')}</pre>`}</div>`;
    } else drawHistory(body);
  }
  function syncGutter() {
    const ta = F.ov && F.ov.querySelector('.fe-ta'); const g = F.ov && F.ov.querySelector('#fe-gut'); if (!ta || !g) return;
    const n = ta.value.split('\n').length; if (g.dataset.n !== String(n)) { g.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); g.dataset.n = n; }
    g.scrollTop = ta.scrollTop;
  }

  async function save() {
    if (!F.canEdit || !F.cur || F.text === F.saved || F.saving) return;
    F.saving = true; clearTimeout(F.timer); status('Saving…'); const text = F.text;
    try {
      const r = await api('/api/files', { method: 'POST', body: { project: F.project, action: 'save', path: F.cur, text, baseMtimeMs: F.mtime } });
      F.saved = text; F.mtime = r.mtimeMs; status(F.text === text ? 'Saved' : 'Unsaved changes…', 'ok');
      if (F.text !== text) F.timer = setTimeout(save, 1500);
    } catch (e) {
      if (/changed on disk/.test(e.message)) { status('Changed on disk by someone else: not saved', 'bad'); conflict(); }
      else { status(`Not saved: ${e.message}`, 'bad'); }
    } finally { F.saving = false; }
  }
  async function conflict() {
    let cur; try { cur = await api(`/api/files?project=${encodeURIComponent(F.project)}&op=read&path=${encodeURIComponent(F.cur)}`); } catch { return; }
    const body = F.ov.querySelector('#fe-body'); F.mode = 'conflict';
    const d = diffLocal(cur.text, F.text);
    body.innerHTML = `<div class="fe-diff"><div class="small" style="padding:6px 6px 10px">This file changed on disk while you were editing it (maybe an agent changed it). Green is yours, red is what's on disk now.<div class="fe-bar" style="margin-top:8px"><button class="btn sm" id="fe-mine">Keep mine (overwrite)</button><button class="btn sm ghost" id="fe-theirs">Use the disk version (drop mine)</button></div></div>${d}</div>`;
    body.querySelector('#fe-mine').onclick = async () => { F.mtime = cur.mtimeMs; F.mode = 'edit'; drawMain(); await save(); };
    body.querySelector('#fe-theirs').onclick = () => { F.text = cur.text; F.saved = cur.text; F.mtime = cur.mtimeMs; F.mode = 'edit'; drawMain(); status('Reloaded from disk', 'ok'); };
  }
  function diffLocal(a, b) { // small client-side line diff for the conflict view (server does history diffs)
    const A = a.split('\n'); const B = b.split('\n'); const setA = new Set(A); const setB = new Set(B); const out = [];
    let i = 0; let j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { out.push(`<div>${esc(A[i])}</div>`); i++; j++; }
      else if (j < B.length && !setA.has(B[j])) { out.push(`<div class="a">${esc(B[j])}</div>`); j++; }
      else if (i < A.length && !setB.has(A[i])) { out.push(`<div class="r">${esc(A[i])}</div>`); i++; }
      else { if (i < A.length) out.push(`<div class="r">${esc(A[i++])}</div>`); if (j < B.length) out.push(`<div class="a">${esc(B[j++])}</div>`); }
    }
    return out.join('');
  }
  async function drawHistory(body) {
    body.innerHTML = '<div class="fe-prev" id="fe-hist">Loading…</div>';
    let d; try { d = await api(`/api/files?project=${encodeURIComponent(F.project)}&op=history&path=${encodeURIComponent(F.cur)}`); } catch (e) { body.innerHTML = `<div class="fe-prev">${esc(e.message)}</div>`; return; }
    const h = body.querySelector('#fe-hist');
    h.innerHTML = `<div class="small muted">A version is kept every time the file is saved from Cortex (newest 30). Compare one with the current file, or restore it.</div>` + (d.versions.map((v) => `<div class="fe-ver"><b>${new Date(v.at).toLocaleString()}</b> · ${esc(v.why)} · ${Math.round(v.size / 102.4) / 10} KB
      <div class="fe-bar" style="margin-top:4px"><button class="btn sm ghost" data-cmp="${esc(v.id)}">Compare with now</button>${F.canEdit ? `<button class="btn sm ghost" data-rs="${esc(v.id)}">Restore</button>` : ''}</div><div class="fe-diff" id="d-${esc(v.id)}" style="display:none"></div></div>`).join('') || '<div class="small" style="margin-top:8px">No earlier versions yet.</div>');
    h.querySelectorAll('[data-cmp]').forEach((b) => (b.onclick = async () => {
      const box = h.querySelector('#d-' + b.dataset.cmp); if (box.style.display === 'block') { box.style.display = 'none'; return; }
      try { const r = await api(`/api/files?project=${encodeURIComponent(F.project)}&op=diff&path=${encodeURIComponent(F.cur)}&id=${encodeURIComponent(b.dataset.cmp)}`); box.innerHTML = r.tooBig ? 'Too big to compare line by line.' : `<div class="small muted">+${r.added} −${r.removed} lines since this version</div>` + r.lines.map((l) => `<div class="${l.op === '+' ? 'a' : l.op === '-' ? 'r' : ''}">${esc(l.text)}</div>`).join(''); box.style.display = 'block'; } catch (e) { fail(e); }
    }));
    h.querySelectorAll('[data-rs]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Restore this version? The current text is kept as a version too, so you can undo this.')) return;
      try { const r = await api('/api/files', { method: 'POST', body: { project: F.project, action: 'restore', path: F.cur, id: b.dataset.rs } }); F.text = r.text; F.saved = r.text; F.mtime = r.mtimeMs; F.mode = 'edit'; drawMain(); status('Restored', 'ok'); } catch (e) { fail(e); }
    }));
  }

  window.openFileEditor = open;

  // ---- entry point on each project page ----
  function projectPanel() {
    if (S.route[0] !== 'projects' || !S.route[1]) return;
    const main = document.querySelector('#main'); if (!main || main.querySelector('#fe-panel')) return;
    const p = (S.projects || []).find((x) => (x.slug || String(x.id).split('/')[1]) === S.route[1]); if (!p) return;
    const folder = p.folder || (p.meta && p.meta.folder);
    const panel = document.createElement('div'); panel.className = 'panel'; panel.id = 'fe-panel'; panel.style.marginTop = '14px';
    panel.innerHTML = `<h3>Files</h3>${folder ? `<p class="small muted">Edit this project's text and code files right here: autosave, preview, search and version history. Secrets like .env files are never opened.</p><button class="btn sm" id="fe-open">Open the file editor</button>` : '<p class="small muted">Set this project\'s folder to edit its files here.</p>'}`;
    main.appendChild(panel);
    const b = panel.querySelector('#fe-open'); if (b) b.onclick = () => open(S.route[1]);
  }
  async function settingsPanel() {
    if (S.route[0] !== 'settings' || !S.local) return;
    const grid = document.querySelector('.settings-grid'); if (!grid || grid.querySelector('#fe-set')) return;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'fe-set'; grid.appendChild(p);
    let on = false; try { on = !!((await api('/api/settings')).files || {}).remoteEdit; } catch { /* default off */ }
    p.innerHTML = `<h3>Project files</h3><label class="small"><input type="checkbox" id="fe-remote" ${on ? 'checked' : ''}> Allow editing project files from my phone and other devices</label><p class="small muted">Off: other devices can read files but not change them. This computer can always edit.</p>`;
    p.querySelector('#fe-remote').onchange = async (e) => { try { await api('/api/files/settings', { method: 'POST', body: { remoteEdit: e.target.checked } }); toast('Saved'); } catch (er) { fail(er); e.target.checked = !e.target.checked; } };
  }
  const wrap = (name, after) => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); Promise.resolve(r).then(() => after()).catch((e) => console.warn(name, e)); return r; }; };
  wrap('renderProjects', projectPanel);
  wrap('renderSettings', settingsPanel);
})();
