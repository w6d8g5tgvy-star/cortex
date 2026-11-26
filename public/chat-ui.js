// Cortex 2.3: Chat page (checklist #21). One conversation, any supported AI tool on this computer, same project context.
(() => {
  const css = `
  .ch-wrap{display:grid;grid-template-columns:260px 1fr;gap:14px;align-items:start}
  .ch-list .ch-item{padding:8px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:6px;cursor:pointer}
  .ch-list .ch-item.on{border-color:rgba(124,92,255,.7);background:rgba(124,92,255,.08)}
  .ch-thread{display:flex;flex-direction:column;gap:10px;min-height:340px;max-height:62vh;overflow:auto;padding:4px 2px}
  .ch-msg{max-width:86%;padding:10px 13px;border-radius:14px;border:1px solid var(--edge,rgba(255,255,255,.08));line-height:1.55;font-size:14px}
  .ch-msg.user{align-self:flex-end;background:rgba(124,92,255,.14);border-color:rgba(124,92,255,.35)}
  .ch-msg.assistant{align-self:flex-start;background:var(--panel,#0e1022)}
  .ch-msg.err{border-color:rgba(255,93,122,.6)}
  .ch-meta{font-size:11px;color:var(--text-3,#889);margin-bottom:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .ch-meta button{background:none;border:0;color:var(--text-3,#889);cursor:pointer;font-size:11px;padding:0;text-decoration:underline}
  .ch-comp{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .ch-comp textarea{width:100%;min-height:70px;padding:10px 12px;border-radius:12px;border:1px solid var(--edge,rgba(255,255,255,.1));background:rgba(6,9,22,.45);color:var(--text,#eef);font:inherit;resize:vertical}
  .ch-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .ch-row select{padding:7px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.1));background:rgba(6,9,22,.45);color:var(--text,#eef)}
  .ch-row select option{background:#10142a}
  .ch-att{font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--edge,rgba(255,255,255,.12))}
  .ch-dots::after{content:'…';animation:chd 1.2s steps(3) infinite}@keyframes chd{0%{content:'.'}50%{content:'..'}100%{content:'...'}}
  @media (max-width:900px){.ch-wrap{grid-template-columns:1fr}.ch-thread{max-height:none}.ch-msg{max-width:100%}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const C = { data: null, cur: null, conv: null, atts: [], poll: null };
  const projects = () => (typeof S !== 'undefined' && S.projects) || [];
  const slug = (p) => p.slug || String(p.id || '').split('/')[1];
  const remembered = (k, d) => { try { return localStorage.getItem('cortex.chat.' + k) || d; } catch { return d; } };
  const remember = (k, v) => { try { localStorage.setItem('cortex.chat.' + k, v); } catch { /* private */ } };

  window.renderChat = async function renderChat() {
    const main = document.querySelector('#main');
    try { C.data = await api('/api/chat'); } catch (e) { main.innerHTML = `<div class="panel">Couldn't load conversations: ${esc(e.message)}</div>`; return; }
    if (!C.cur && C.data.conversations[0]) C.cur = C.data.conversations[0].id;
    const t = C.data.tools || {};
    const opts = [['auto', 'Automatic (Cortex picks)']];
    if (t.claude && t.claude.installed) opts.push(['claude:opus', 'Claude Opus'], ['claude:sonnet', 'Claude Sonnet'], ['claude:haiku', 'Claude Haiku']);
    if (t.codex && t.codex.installed) opts.push(['codex:', 'Codex (its default model)']);
    const none = !(t.claude && t.claude.installed) && !(t.codex && t.codex.installed);
    const pick = remembered('model', 'auto');
    main.innerHTML = `<div class="page-head"><h1>Chat</h1><p class="muted small">Talk to Claude Code or Codex on this computer. Every chat knows your project's instructions, memories and open tasks, and you can switch models mid-conversation without losing the thread.</p></div>
      <div class="ch-wrap">
        <div class="panel ch-list"><div class="ch-row"><select id="ch-proj" style="flex:1"><option value="">No project</option>${projects().map((p) => `<option value="${esc(slug(p))}" ${slug(p) === remembered('project', '') ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select><button class="btn sm" id="ch-new">+ New</button></div><div id="ch-items"></div>
          <p class="small muted" style="margin-top:12px">${esc(C.data.notSupported || '')}</p></div>
        <div class="panel"><div id="ch-head" class="ch-row" style="justify-content:space-between"></div>
          <div class="ch-thread" id="ch-thread"></div>
          <form class="ch-comp" id="ch-form">
            ${none ? `<div class="small" style="color:#ffc35c">Neither Claude Code nor Codex is installed on this computer, so chat can't answer yet. ${esc((t.claude && t.claude.help) || '')}</div>` : ''}
            ${C.data.agentsEnabled ? '' : '<div class="small" style="color:#ffc35c">Starting agents is turned off. Turn it on in Settings → Agent control (on your main computer).</div>'}
            <textarea id="ch-text" placeholder="Ask anything about this project… (Enter to send, Shift+Enter for a new line)"></textarea>
            <div class="ch-row"><select id="ch-model">${opts.map(([v, l]) => `<option value="${v}" ${v === pick ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
              <label class="btn sm ghost" style="cursor:pointer">Attach<input type="file" id="ch-file" multiple style="display:none"></label><span id="ch-atts"></span>
              <span style="flex:1"></span><button class="btn" id="ch-send" type="submit">Send</button></div>
          </form></div>
      </div>`;
    document.querySelector('#ch-new').onclick = async () => { try { const r = await api('/api/chat', { method: 'POST', body: { action: 'create', project: document.querySelector('#ch-proj').value || null } }); C.cur = r.conversation.id; renderChat(); setTimeout(() => document.querySelector('#ch-text')?.focus(), 50); } catch (e) { fail(e); } };
    document.querySelector('#ch-model').onchange = (e) => remember('model', e.target.value);
    document.querySelector('#ch-proj').onchange = (e) => remember('project', e.target.value);
    document.querySelector('#ch-file').onchange = (e) => attach([...e.target.files]);
    const ta = document.querySelector('#ch-text');
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.querySelector('#ch-form').requestSubmit(); } };
    document.querySelector('#ch-form').onsubmit = (e) => { e.preventDefault(); send(); };
    drawItems(); await openConv();
  };

  function drawItems() {
    const box = document.querySelector('#ch-items'); if (!box) return;
    box.innerHTML = C.data.conversations.map((c) => `<div class="ch-item ${c.id === C.cur ? 'on' : ''}" data-ch="${esc(c.id)}"><b>${esc(c.title)}</b><div class="small muted">${c.project ? esc(c.project) + ' · ' : ''}${c.messages} messages · ${timeAgo(c.updated)}${c.busy ? ' · answering…' : ''}</div></div>`).join('') || '<div class="small muted" style="margin-top:8px">No conversations yet. Press + New.</div>';
    box.querySelectorAll('[data-ch]').forEach((el) => (el.onclick = () => { C.cur = el.dataset.ch; C.atts = []; drawItems(); openConv(); }));
  }

  async function openConv() {
    clearTimeout(C.poll);
    const th = document.querySelector('#ch-thread'); const head = document.querySelector('#ch-head'); if (!th) return;
    if (!C.cur) { C.conv = null; head.innerHTML = ''; th.innerHTML = '<div class="small muted">Start a new conversation on the left.</div>'; return; }
    try { C.conv = (await api('/api/chat?id=' + encodeURIComponent(C.cur))).conversation; } catch (e) { th.innerHTML = `<div class="small muted">${esc(e.message)}</div>`; return; }
    const c = C.conv;
    head.innerHTML = `<div><b>${esc(c.title)}</b> <span class="small muted">${c.project ? 'Project: ' + esc(c.project) : 'No project'}</span></div>
      <div class="ch-row"><button class="btn sm ghost" id="ch-hand" title="Give this conversation to another agent (Claude, Codex, ChatGPT…) as a task">Hand off</button><button class="btn sm ghost" id="ch-ren">Rename</button><button class="btn sm ghost" id="ch-del">Delete</button></div>`;
    head.querySelector('#ch-ren').onclick = async () => { const t = prompt('Name this conversation', c.title); if (!t) return; await api('/api/chat', { method: 'POST', body: { action: 'rename', id: c.id, title: t } }); renderChat(); };
    head.querySelector('#ch-del').onclick = async () => { if (!confirm(`Delete "${c.title}"?`)) return; await api('/api/chat', { method: 'POST', body: { action: 'delete', id: c.id } }); C.cur = null; renderChat(); };
    head.querySelector('#ch-hand').onclick = async () => {
      const to = prompt('Hand off to which agent? (claude, codex, chatgpt, or any)', 'any'); if (!to) return;
      const note = prompt('What should they do with it? (optional)', '') || '';
      try { const r = await api('/api/chat', { method: 'POST', body: { action: 'handoff', id: c.id, to, note } }); toast(`Handed off to ${r.command.target}: they'll get it next time they check Cortex`); } catch (e) { fail(e); }
    };
    th.innerHTML = c.messages.map((m) => msgHtml(m)).join('') || '<div class="small muted">Say hello. The AI gets this project\'s brief automatically.</div>';
    th.querySelectorAll('[data-rem]').forEach((b) => (b.onclick = async () => { try { const r = await api('/api/chat', { method: 'POST', body: { action: 'remember', id: c.id, message: b.dataset.rem } }); toast(`Saved as memory "${r.note.title}"`); } catch (e) { fail(e); } }));
    th.scrollTop = th.scrollHeight;
    const busy = c.messages.some((m) => m.pending);
    const sendBtn = document.querySelector('#ch-send'); if (sendBtn) sendBtn.disabled = busy;
    if (busy) C.poll = setTimeout(async () => { if (S.route[0] !== 'chat') return; await openConv(); if (!C.conv.messages.some((m) => m.pending)) { C.data = await api('/api/chat').catch(() => C.data); drawItems(); } }, 2000);
  }

  function msgHtml(m) {
    if (m.role === 'user') return `<div class="ch-msg user"><div class="ch-meta">You · ${timeAgo(m.ts)}</div>${esc(m.text).replace(/\n/g, '<br>')}${(m.attachments || []).length ? `<div class="ch-meta" style="margin-top:6px">📎 ${m.attachments.map((a) => esc(a.name)).join(', ')}</div>` : ''}</div>`;
    const who = m.tool === 'codex' ? `Codex${m.model ? ' · ' + m.model : ''}` : `Claude${m.model ? ' · ' + m.model : ''}`;
    const why = m.route && m.route.reasons ? `Picked automatically: ${m.route.reasons.join('; ') || 'medium request'}` : 'You chose this model';
    if (m.pending) return `<div class="ch-msg assistant"><div class="ch-meta" title="${esc(why)}">${esc(who)}</div><span class="muted ch-dots">Thinking</span> <a class="small" href="#/live">watch live</a></div>`;
    return `<div class="ch-msg assistant ${m.error ? 'err' : ''}"><div class="ch-meta"><span title="${esc(why)}">${esc(who)}${m.route ? ' (auto)' : ''}</span><span>${timeAgo(m.done || m.ts)}</span>${m.error ? '<span style="color:#ff7a90">didn\'t finish</span>' : `<button data-rem="${esc(m.id)}">Save as memory</button>`}</div><div class="md">${md(m.text || '')}</div></div>`;
  }

  async function attach(files) {
    const c = C.conv; if (!c) return toast('Start a conversation first');
    for (const f of files) {
      try {
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name), ...(c.project ? { 'X-Project': c.project } : {}), ...(typeof TOKEN !== 'undefined' && TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) }, body: f });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Upload failed');
        C.atts.push({ name: j.name, path: j.path });
      } catch (e) { fail(e); }
    }
    drawAtts();
  }
  function drawAtts() {
    const el = document.querySelector('#ch-atts'); if (!el) return;
    el.innerHTML = C.atts.map((a, i) => `<span class="ch-att">${esc(a.name)} <a href="#" data-rm="${i}">×</a></span>`).join(' ');
    el.querySelectorAll('[data-rm]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); C.atts.splice(Number(a.dataset.rm), 1); drawAtts(); }));
  }

  async function send() {
    const ta = document.querySelector('#ch-text'); const text = ta.value.trim(); if (!text) return;
    if (!C.cur) { try { const r = await api('/api/chat', { method: 'POST', body: { action: 'create', project: document.querySelector('#ch-proj').value || null } }); C.cur = r.conversation.id; } catch (e) { return fail(e); } }
    const [tool, model] = (document.querySelector('#ch-model').value || 'auto').split(':');
    const btn = document.querySelector('#ch-send'); btn.disabled = true;
    try {
      const r = await api('/api/chat', { method: 'POST', body: { action: 'send', id: C.cur, text, tool: tool === 'auto' ? 'auto' : tool, model: tool === 'auto' ? 'auto' : model, attachments: C.atts } });
      ta.value = ''; C.atts = []; drawAtts();
      if (r.resumed) toast('Continuing the same session');
      C.data = await api('/api/chat'); drawItems(); await openConv();
    } catch (e) { fail(e); btn.disabled = false; }
  }
})();
