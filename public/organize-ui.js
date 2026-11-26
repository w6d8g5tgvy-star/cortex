// Cortex 2.3: "Tidy up" panel (checklist #33) on the Projects page. Suggestions to approve one by one; some kinds can
// be allowed to run on their own. Nothing is deleted; every change is a normal edit you can undo.
(() => {
  const LABEL = { tag: 'Tags', project: 'File under a project', related: 'Link related memories', duplicate: 'Possible duplicates', outdated: 'Possibly outdated', file: 'File inbox attachments', priority: 'Task priorities' };
  const st = document.createElement('style');
  st.textContent = `.og-item{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:6px}
  .og-item .k{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3,#889)}.og-item .w{font-size:12px;color:var(--text-3,#889);margin-top:2px}
  .og-item .b{margin-left:auto;display:flex;gap:6px;flex-shrink:0}.og-f{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  @media (max-width:640px){.og-item{flex-direction:column}.og-item .b{margin-left:0}}`;
  document.head.appendChild(st);
  let filter = '';

  async function panel() {
    if (S.route[0] !== 'projects' || S.route[1]) return;
    const main = document.querySelector('#main'); if (!main || main.querySelector('#og-panel')) return;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'og-panel'; p.style.marginTop = '14px'; main.appendChild(p);
    draw(p);
  }
  async function draw(p) {
    let d; try { d = await api('/api/organize'); } catch (e) { p.innerHTML = `<h3>Tidy up</h3><div class="small muted">${esc(e.message)}</div>`; return; }
    const counts = {}; for (const s of d.suggestions) counts[s.kind] = (counts[s.kind] || 0) + 1;
    const list = d.suggestions.filter((s) => !filter || s.kind === filter);
    p.innerHTML = `<h3>Tidy up <span class="small muted">${d.suggestions.length} suggestion(s)</span></h3>
      <p class="small muted" style="margin:2px 0 0">Cortex looks for missing tags, unfiled memories, related or duplicate notes, outdated information, inbox files and task priorities. Nothing changes until you press Apply, and nothing is ever deleted.</p>
      <div class="og-f"><button class="btn sm ${filter ? 'ghost' : ''}" data-og-f="">All</button>${Object.entries(counts).map(([k, n]) => `<button class="btn sm ${filter === k ? '' : 'ghost'}" data-og-f="${k}">${esc(LABEL[k] || k)} (${n})</button>`).join('')}</div>
      ${list.slice(0, 40).map((s) => `<div class="og-item"><div><div class="k">${esc(LABEL[s.kind] || s.kind)}</div><b>${esc(s.title)}</b><div class="w">${esc(s.why)}</div></div><div class="b"><button class="btn sm" data-og-a="${esc(s.id)}">Apply</button><button class="btn sm ghost" data-og-d="${esc(s.id)}">Dismiss</button></div></div>`).join('') || '<div class="small muted" style="margin-top:8px">All tidy. Nothing to suggest right now.</div>'}
      ${S.local ? `<details style="margin-top:12px"><summary class="small">Let Cortex do some of this on its own</summary><div class="small muted" style="margin:6px 0">Checked kinds are applied automatically every few hours (and logged in the activity feed). Priorities, duplicates and outdated flags always wait for you.</div>${d.safeAuto.map((k) => `<label class="small" style="display:block"><input type="checkbox" data-og-auto="${k}" ${d.auto.includes(k) ? 'checked' : ''}> ${esc(LABEL[k])}</label>`).join('')}</details>` : ''}
      ${d.history.length ? `<details style="margin-top:8px"><summary class="small">Recently tidied (${d.history.length})</summary>${d.history.slice(0, 15).map((h) => `<div class="small muted">${timeAgo(h.at)} · ${esc(h.summary)} · ${esc(h.by)}</div>`).join('')}<div class="small muted" style="margin-top:4px">Changed your mind? Use Undo (Ctrl+K → "undo") or the item's history.</div></details>` : ''}`;
    p.querySelectorAll('[data-og-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.ogF; draw(p); }));
    p.querySelectorAll('[data-og-a]').forEach((b) => (b.onclick = async () => { b.disabled = true; try { const r = await api('/api/organize', { method: 'POST', body: { action: 'apply', id: b.dataset.ogA } }); toast(r.summary); draw(p); } catch (e) { fail(e); b.disabled = false; } }));
    p.querySelectorAll('[data-og-d]').forEach((b) => (b.onclick = async () => { try { await api('/api/organize', { method: 'POST', body: { action: 'dismiss', id: b.dataset.ogD } }); draw(p); } catch (e) { fail(e); } }));
    p.querySelectorAll('[data-og-auto]').forEach((c) => (c.onchange = async () => { const auto = [...p.querySelectorAll('[data-og-auto]:checked')].map((x) => x.dataset.ogAuto); try { await api('/api/organize', { method: 'POST', body: { action: 'auto', auto } }); toast(auto.length ? 'Automatic tidy-up on for: ' + auto.map((k) => LABEL[k]).join(', ') : 'Automatic tidy-up off'); } catch (e) { fail(e); } }));
  }
  const wrap = (name, after) => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); Promise.resolve(r).then(() => after()).catch((e) => console.warn(name, e)); return r; }; };
  wrap('renderProjects', panel);
})();
