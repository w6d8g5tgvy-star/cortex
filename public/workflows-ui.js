// Cortex 2.3: Workflows page (checklist #34). A no-code builder: drag steps on a canvas, connect them, test for free
// (agents and writes are simulated), then run for real. Every run keeps a step-by-step log for debugging.
(() => {
  const css = `
  .wf-wrap{display:grid;grid-template-columns:240px 1fr 320px;gap:14px;align-items:start}
  .wf-list .wf-item{padding:8px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:6px;cursor:pointer}
  .wf-list .wf-item.on{border-color:rgba(124,92,255,.7);background:rgba(124,92,255,.08)}
  .wf-canvas{position:relative;min-height:520px;overflow:auto;border-radius:14px;border:1px dashed var(--edge-2,rgba(255,255,255,.15));background-image:radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px);background-size:22px 22px}
  .wf-canvas svg{position:absolute;inset:0;pointer-events:none;overflow:visible}
  .wf-node{position:absolute;width:180px;padding:9px 11px;border-radius:12px;background:var(--panel,#0e1022);border:1px solid var(--edge-2,rgba(255,255,255,.18));cursor:grab;user-select:none;box-shadow:0 8px 24px rgba(0,0,0,.35);touch-action:none}
  .wf-node.sel{border-color:#7c5cff;box-shadow:0 0 0 2px rgba(124,92,255,.35)}
  .wf-node .t{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3,#889)}
  .wf-node .n{font-size:12.5px;font-weight:600;margin-top:2px;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .wf-node.trigger{border-color:#3ddc97}.wf-node.approval{border-color:#ffc35c}.wf-node.condition{border-color:#5cc8ff}.wf-node.agent{border-color:#b48cff}
  .wf-node.ran{outline:2px solid rgba(61,220,151,.55)}.wf-node.bad{outline:2px solid rgba(255,93,122,.7)}
  .wf-ed label{display:block;font-size:12px;color:var(--text-2,#aab);margin-top:8px}
  .wf-ed label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--text-3,#889);font-weight:650;margin-top:10px}
  .wf-ed input,.wf-ed textarea,.wf-ed select,#wf-name{width:100%;margin-top:5px;padding:8px 11px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.1));background:rgba(6,9,22,.45);color:var(--text,#eef);font:inherit;font-size:13px;text-transform:none;letter-spacing:0}
  .wf-ed select[multiple] option{padding:3px 4px}.wf-ed select option{background:#10142a}
  .wf-ed textarea{min-height:80px}
  .wf-pal{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
  .wf-msg{font-size:12px;margin-top:6px}.wf-msg.err{color:#ff7a90}.wf-msg.warn{color:#ffc35c}
  .wf-run{padding:8px 10px;border-radius:10px;border:1px solid var(--edge,rgba(255,255,255,.08));margin-top:6px;font-size:12.5px}
  .wf-step{display:flex;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--edge,rgba(255,255,255,.05))}
  .wf-step .ok{color:#3ddc97}.wf-step .no{color:#ff7a90}
  @media (max-width:1100px){.wf-wrap{grid-template-columns:1fr}.wf-canvas{min-height:0;height:auto;display:flex;flex-direction:column;gap:8px;padding:10px;border-style:solid}.wf-canvas svg{display:none}.wf-node{position:static;width:auto}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const W = { data: null, cur: null, sel: null, dirty: false, lastRun: null };
  const blank = () => ({ name: 'New workflow', description: '', enabled: true, limits: {}, layout: {}, nodes: [{ id: 'start', type: 'trigger', config: { on: 'manual' }, next: [] }] });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const short = (n) => { const c = n.config || {}; return c.prompt || c.title || c.message || (n.type === 'trigger' ? ({ manual: 'Started by hand', schedule: `Every ${c.everyMinutes || '?'} min`, 'task.created': 'When a task is created', 'task.done': 'When a task is finished' }[c.on || 'manual']) : n.type === 'tool' ? c.name : n.type === 'condition' ? `If ${c.left || 'last output'} ${(c.op || 'contains').replace('_', ' ')} ${c.value || ''}` : n.type === 'output' ? (c.save === 'memory' ? 'Save as memory' : 'Finish') : n.id); };
  // Steps the user hasn't dragged are laid out top-down by depth from the trigger (one row per level).
  function autoLayout() {
    const byId = Object.fromEntries(W.cur.nodes.map((n) => [n.id, n])); const depth = {};
    const start = W.cur.nodes.find((n) => n.type === 'trigger'); const q = start ? [[start.id, 0]] : [];
    while (q.length) { const [id, d] = q.shift(); if (depth[id] !== undefined || !byId[id]) continue; depth[id] = d; for (const t of [...(byId[id].next || []), ...(byId[id].else || [])]) q.push([t, d + 1]); }
    let maxD = Math.max(0, ...Object.values(depth)); for (const n of W.cur.nodes) if (depth[n.id] === undefined) depth[n.id] = ++maxD;
    const rows = {}; for (const n of W.cur.nodes) (rows[depth[n.id]] = rows[depth[n.id]] || []).push(n.id);
    const out = {}; for (const [d, ids] of Object.entries(rows)) ids.forEach((id, i) => { out[id] = { x: 16 + i * 200, y: 16 + Number(d) * 112 }; });
    return out;
  }
  let AUTO = {};
  const pos = (n) => (W.cur.layout && W.cur.layout[n.id]) || AUTO[n.id] || { x: 16, y: 16 };
  const uid = (type) => { let i = 1; while (W.cur.nodes.some((n) => n.id === `${type}${i}`)) i++; return `${type}${i}`; };

  async function load() { W.data = await api('/api/workflows'); }

  window.renderWorkflows = async function renderWorkflows() {
    const main = document.querySelector('#main');
    try { await load(); } catch (e) { main.innerHTML = `<div class="panel">Couldn't load workflows: ${esc(e.message)}</div>`; return; }
    if (!W.cur) { const first = W.data.workflows[0]; W.cur = first ? clone(first) : null; }
    main.innerHTML = `<div class="page-head"><h1>Workflows</h1><p class="muted small">Connect a trigger to agents, tools, conditions, approvals, tasks and notifications. <b>Test</b> is free: agents and changes are only simulated. <b>Run</b> does it for real, within the limits you set.</p></div>
      <div class="wf-wrap">
        <div class="panel wf-list"><h3>Your workflows</h3><div id="wf-mine"></div><button class="btn sm" id="wf-new" style="margin-top:8px">+ Blank workflow</button>
          <h3 style="margin-top:14px">Start from a template</h3><div id="wf-tpl"></div></div>
        <div><div class="panel" style="padding:10px"><div class="in-row"><input id="wf-name" placeholder="Workflow name" style="flex:1;min-width:160px"><label class="small"><input type="checkbox" id="wf-en"> On</label></div>
          <div class="wf-pal" id="wf-pal"></div><div class="in-row"><button class="btn sm" id="wf-save">Save</button><button class="btn sm ghost" id="wf-test">Test (free)</button><button class="btn sm ghost" id="wf-run">Run now</button><button class="btn sm ghost" id="wf-del">Delete</button></div><div id="wf-val"></div></div>
          <div class="wf-canvas" id="wf-canvas" style="margin-top:10px"></div></div>
        <div><div class="panel wf-ed" id="wf-ed"></div><div class="panel" style="margin-top:12px"><h3>Runs</h3><div id="wf-runs"></div></div></div>
      </div>`;
    drawList(); drawEditorChrome(); drawCanvas(); drawEditor(); drawRuns();
    document.querySelector('#wf-new').onclick = () => { if (!confirmLeave()) return; W.cur = blank(); W.sel = 'start'; W.dirty = true; W.lastRun = null; refresh(); };
  };

  function confirmLeave() { return !W.dirty || confirm('You have unsaved changes. Discard them?'); }
  function refresh() { drawList(); drawEditorChrome(); drawCanvas(); drawEditor(); drawRuns(); }

  function drawList() {
    const mine = document.querySelector('#wf-mine'); if (!mine) return;
    mine.innerHTML = W.data.workflows.map((w) => `<div class="wf-item ${W.cur && W.cur.id === w.id ? 'on' : ''}" data-wf="${esc(w.id)}"><b>${esc(w.name)}</b>${w.enabled === false ? ' <span class="muted small">(off)</span>' : ''}<div class="small muted">${esc((w.nodes.find((n) => n.type === 'trigger') || {}).config?.on || 'manual')} · ${w.nodes.length} steps</div></div>`).join('') || '<div class="small muted">None yet. Start from a template below.</div>';
    mine.querySelectorAll('[data-wf]').forEach((el) => (el.onclick = () => { if (!confirmLeave()) return; W.cur = clone(W.data.workflows.find((w) => w.id === el.dataset.wf)); W.sel = null; W.dirty = false; W.lastRun = null; refresh(); }));
    const tpl = document.querySelector('#wf-tpl');
    tpl.innerHTML = W.data.templates.map((t, i) => `<div class="wf-item" data-tpl="${i}"><b>${esc(t.name)}</b><div class="small muted">${esc(t.description)}</div></div>`).join('');
    tpl.querySelectorAll('[data-tpl]').forEach((el) => (el.onclick = () => { if (!confirmLeave()) return; const t = clone(W.data.templates[Number(el.dataset.tpl)]); W.cur = { ...t, enabled: true, limits: {}, layout: {} }; W.sel = null; W.dirty = true; W.lastRun = null; refresh(); toast('Template loaded: check the steps, then Save'); }));
  }

  function drawEditorChrome() {
    const name = document.querySelector('#wf-name'); const en = document.querySelector('#wf-en');
    const has = !!W.cur;
    ['#wf-save', '#wf-test', '#wf-run', '#wf-del'].forEach((s) => { const b = document.querySelector(s); if (b) b.disabled = !has; });
    if (!has) { name.value = ''; name.disabled = true; document.querySelector('#wf-pal').innerHTML = '<span class="small muted">Pick a workflow or a template to start.</span>'; return; }
    name.disabled = false; name.value = W.cur.name || ''; en.checked = W.cur.enabled !== false;
    name.oninput = () => { W.cur.name = name.value; W.dirty = true; };
    en.onchange = () => { W.cur.enabled = en.checked; W.dirty = true; };
    const pal = document.querySelector('#wf-pal');
    pal.innerHTML = Object.entries(W.data.types).filter(([k]) => k !== 'trigger').map(([k, t]) => `<button class="btn sm ghost" data-add="${k}" title="${esc(t.help)}">+ ${esc(t.label)}</button>`).join('');
    pal.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => addNode(b.dataset.add)));
    document.querySelector('#wf-save').onclick = save;
    document.querySelector('#wf-test').onclick = () => run(true);
    document.querySelector('#wf-run').onclick = () => run(false);
    document.querySelector('#wf-del').onclick = async () => {
      if (!W.cur.id) { W.cur = null; W.dirty = false; return refresh(); }
      if (!confirm(`Delete "${W.cur.name}"? (A copy is kept in .cortex/workflows/deleted.)`)) return;
      try { await api('/api/workflows', { method: 'POST', body: { action: 'delete', id: W.cur.id } }); W.cur = null; W.dirty = false; await load(); refresh(); toast('Deleted'); } catch (e) { fail(e); }
    };
  }

  const DEFAULTS = { agent: { prompt: '', tool: 'claude', maxMinutes: 30 }, tool: { name: 'memory_search', query: '{{trigger.title}}' }, condition: { left: '{{last.output}}', op: 'contains', value: '' }, approval: { message: 'Approve? {{last.output}}' }, task: { title: '', priority: 'medium' }, notify: { title: '' }, output: { save: 'none' } };
  function addNode(type) {
    const id = uid(type);
    const from = W.cur.nodes.find((n) => n.id === W.sel) || W.cur.nodes[W.cur.nodes.length - 1];
    W.cur.nodes.push({ id, type, config: clone(DEFAULTS[type] || {}), next: [], ...(type === 'condition' || type === 'approval' ? { else: [] } : {}) });
    if (from && from.type !== 'output' && !(from.next || []).length) from.next = [id]; // connect it after the selected step
    W.sel = id; W.dirty = true; drawCanvas(); drawEditor();
  }

  function drawCanvas() {
    const cv = document.querySelector('#wf-canvas'); if (!cv) return;
    if (!W.cur) { cv.innerHTML = ''; return; }
    AUTO = autoLayout();
    const ran = new Map(((W.lastRun && W.lastRun.steps) || []).map((s) => [s.node, s.ok]));
    let maxX = 0; let maxY = 0;
    const nodes = W.cur.nodes.map((n, i) => { const p = pos(n, i); maxX = Math.max(maxX, p.x + 190); maxY = Math.max(maxY, p.y + 80); return `<div class="wf-node ${n.type} ${W.sel === n.id ? 'sel' : ''} ${ran.has(n.id) ? (ran.get(n.id) ? 'ran' : 'bad') : ''}" data-node="${esc(n.id)}" style="left:${p.x}px;top:${p.y}px"><div class="t">${esc((W.data.types[n.type] || {}).label || n.type)} · ${esc(n.id)}</div><div class="n">${esc(String(short(n)).slice(0, 80))}</div></div>`; }).join('');
    cv.innerHTML = `<svg width="${maxX + 40}" height="${maxY + 40}"><defs><marker id="wf-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8a7dff"/></marker></defs>${edges()}</svg>${nodes}`;
    cv.style.minHeight = Math.max(520, maxY + 60) + 'px';
    cv.querySelectorAll('[data-node]').forEach((el) => dragify(el));
  }
  function edges() {
    const byIdx = (id) => W.cur.nodes.findIndex((n) => n.id === id);
    let out = '';
    for (const [i, n] of W.cur.nodes.entries()) {
      const a = pos(n, i);
      for (const [list, color, label] of [[n.next || [], '#8a7dff', n.type === 'condition' ? 'yes' : n.type === 'approval' ? 'approved' : ''], [n.else || [], '#ff8fa3', n.type === 'condition' ? 'no' : n.type === 'approval' ? 'rejected' : 'failed']]) {
        for (const t of list) {
          const j = byIdx(t); if (j < 0) continue; const b = pos(W.cur.nodes[j], j);
          const x1 = a.x + 90; const y1 = a.y + 64; const x2 = b.x + 90; const y2 = b.y - 2; const my = (y1 + y2) / 2;
          out += `<path d="M${x1} ${y1} C${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none" marker-end="url(#wf-ar)" opacity=".85"/>`;
          if (label) out += `<text x="${(x1 + x2) / 2 + 4}" y="${my - 4}" fill="${color}" font-size="11">${label}</text>`;
        }
      }
    }
    return out;
  }
  function dragify(el) {
    const id = el.dataset.node; let sx; let sy; let ox; let oy; let moved = false;
    el.onpointerdown = (e) => {
      if (window.matchMedia('(max-width:1100px)').matches) { W.sel = id; drawCanvas(); drawEditor(); return; }
      const p = pos(W.cur.nodes.find((n) => n.id === id), W.cur.nodes.findIndex((n) => n.id === id));
      sx = e.clientX; sy = e.clientY; ox = p.x; oy = p.y; moved = false; el.setPointerCapture(e.pointerId);
      el.onpointermove = (ev) => { const dx = ev.clientX - sx; const dy = ev.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; el.style.left = Math.max(0, ox + dx) + 'px'; el.style.top = Math.max(0, oy + dy) + 'px'; };
      el.onpointerup = (ev) => { el.onpointermove = null; el.onpointerup = null; if (moved) { W.cur.layout = W.cur.layout || {}; W.cur.layout[id] = { x: Math.max(0, ox + ev.clientX - sx), y: Math.max(0, oy + ev.clientY - sy) }; W.dirty = true; } W.sel = id; drawCanvas(); drawEditor(); };
    };
  }

  function drawEditor() {
    const ed = document.querySelector('#wf-ed'); if (!ed) return;
    if (!W.cur) { ed.innerHTML = '<h3>Step</h3><div class="small muted">Nothing selected.</div>'; return; }
    const n = W.cur.nodes.find((x) => x.id === W.sel);
    const L = { ...W.data.limits, ...(W.cur.limits || {}) };
    if (!n) {
      ed.innerHTML = `<h3>Workflow settings</h3><label>Description<textarea id="wf-desc">${esc(W.cur.description || '')}</textarea></label>
        <label>Stop after this many steps<input type="number" id="wl-steps" min="1" max="500" value="${L.maxSteps}"></label>
        <label>Most agent runs per run<input type="number" id="wl-agents" min="0" max="20" value="${L.maxAgentRuns}"></label>
        <label>Time limit (minutes)<input type="number" id="wl-min" min="1" max="1440" value="${L.maxMinutes}"></label>
        <p class="small muted" style="margin-top:8px">Click a step to edit it. Use <code>{{last.output}}</code>, <code>{{trigger.title}}</code> or <code>{{steps.ID.output}}</code> to pass results along.</p>`;
      ed.querySelector('#wf-desc').oninput = (e) => { W.cur.description = e.target.value; W.dirty = true; };
      for (const [sel, k] of [['#wl-steps', 'maxSteps'], ['#wl-agents', 'maxAgentRuns'], ['#wl-min', 'maxMinutes']]) ed.querySelector(sel).oninput = (e) => { W.cur.limits = { ...(W.cur.limits || {}), [k]: Number(e.target.value) }; W.dirty = true; };
      return;
    }
    const c = n.config || (n.config = {});
    const others = W.cur.nodes.filter((x) => x.id !== n.id && x.type !== 'trigger');
    const pick = (field, label) => `<label>${label}<select multiple data-link="${field}" size="${Math.min(5, Math.max(2, others.length))}">${others.map((o) => `<option value="${esc(o.id)}" ${(n[field] || []).includes(o.id) ? 'selected' : ''}>${esc(o.id)}: ${esc(String(short(o)).slice(0, 40))}</option>`).join('')}</select></label>`;
    const f = (k, label, type = 'text', extra = '') => type === 'textarea' ? `<label>${label}<textarea data-c="${k}">${esc(c[k] == null ? '' : c[k])}</textarea></label>` : `<label>${label}<input type="${type}" data-c="${k}" value="${esc(c[k] == null ? '' : c[k])}" ${extra}></label>`;
    const sel = (k, label, opts) => `<label>${label}<select data-c="${k}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(c[k] ?? '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const projOpts = [['', 'Any / from the trigger'], ...((typeof S !== 'undefined' && S.projects) || []).map((p) => [p.slug || (p.id || '').split('/')[1], p.title])];
    let body = '';
    if (n.type === 'trigger') body = sel('on', 'Starts', W.data.triggers.map((t) => [t, { manual: 'By hand (Run button)', schedule: 'On a schedule', 'task.created': 'When a task is created', 'task.done': 'When a task is finished' }[t]])) + (c.on === 'schedule' ? f('everyMinutes', 'Every (minutes, 5 or more)', 'number', 'min="5"') : '') + sel('project', 'Only for project', projOpts);
    if (n.type === 'agent') body = f('prompt', 'What should the agent do?', 'textarea') + sel('tool', 'Agent', [['claude', 'Claude Code'], ['codex', 'Codex']]) + f('model', 'Model (blank = automatic routing)') + sel('project', 'Project (for the brief and folder)', projOpts) + f('maxMinutes', 'Time limit (minutes)', 'number', 'min="1" max="240"');
    if (n.type === 'tool') body = sel('name', 'Tool', W.data.tools.map((t) => [t, { memory_search: 'Search memories', memory_write: 'Save a memory', task_update: 'Update a task', project_brief: 'Read a project brief' }[t] || t])) + (c.name === 'memory_search' ? f('query', 'Search for') : '') + (c.name === 'memory_write' ? f('title', 'Title') + f('content', 'Content', 'textarea') : '') + (c.name === 'task_update' ? f('task', 'Task id (blank = the trigger\'s task)') + sel('status', 'Set status', [['', 'unchanged'], ['todo', 'todo'], ['doing', 'doing'], ['done', 'done'], ['blocked', 'blocked']]) : '') + (c.name === 'project_brief' ? f('project', 'Project') : '');
    if (n.type === 'condition') body = f('left', 'Check this') + sel('op', 'is / does', W.data.ops.map((o) => [o, o.replace('_', ' ')])) + (['empty', 'not_empty'].includes(c.op) ? '' : f('value', 'Value'));
    if (n.type === 'approval') body = f('message', 'What you\'ll be asked', 'textarea');
    if (n.type === 'task') body = f('title', 'Task title') + f('body', 'Details', 'textarea') + sel('project', 'Project', projOpts) + sel('priority', 'Priority', [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['urgent', 'urgent']]);
    if (n.type === 'notify') body = f('title', 'Title') + f('body', 'Message', 'textarea');
    if (n.type === 'output') body = sel('save', 'At the end', [['none', 'Just finish'], ['memory', 'Save the result as a memory']]) + (c.save === 'memory' ? f('title', 'Memory title') + sel('project', 'Project', projOpts) : '');
    const branches = n.type === 'output' ? '' : pick('next', n.type === 'condition' ? 'If yes, go to' : n.type === 'approval' ? 'If approved, go to' : 'Then go to') + (['condition', 'approval', 'agent'].includes(n.type) ? pick('else', n.type === 'condition' ? 'If no, go to' : n.type === 'approval' ? 'If rejected, go to' : 'If the agent fails, go to') : '');
    ed.innerHTML = `<h3>${esc((W.data.types[n.type] || {}).label || n.type)} <span class="muted small">${esc(n.id)}</span></h3><div class="small muted">${esc((W.data.types[n.type] || {}).help || '')}</div>${body}${branches}
      <div class="in-row" style="margin-top:10px"><button class="btn sm ghost" id="wf-desel">Workflow settings</button>${n.type !== 'trigger' ? '<button class="btn sm ghost" id="wf-rm">Remove step</button>' : ''}</div>`;
    ed.querySelectorAll('[data-c]').forEach((el) => (el.oninput = el.onchange = () => { const k = el.dataset.c; c[k] = el.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value; if (c[k] === '' && ['model', 'project', 'status'].includes(k)) delete c[k]; W.dirty = true; if (el.tagName === 'SELECT') drawEditor(); drawCanvas(); }));
    ed.querySelectorAll('[data-link]').forEach((el) => (el.onchange = () => { n[el.dataset.link] = [...el.selectedOptions].map((o) => o.value); W.dirty = true; drawCanvas(); }));
    ed.querySelector('#wf-desel').onclick = () => { W.sel = null; drawCanvas(); drawEditor(); };
    const rm = ed.querySelector('#wf-rm'); if (rm) rm.onclick = () => { W.cur.nodes = W.cur.nodes.filter((x) => x.id !== n.id); for (const x of W.cur.nodes) { x.next = (x.next || []).filter((t) => t !== n.id); if (x.else) x.else = x.else.filter((t) => t !== n.id); } W.sel = null; W.dirty = true; drawCanvas(); drawEditor(); };
  }

  function showValidation(v) {
    const el = document.querySelector('#wf-val'); if (!el) return;
    el.innerHTML = (v.errors || []).map((e) => `<div class="wf-msg err">✗ ${esc(e)}</div>`).join('') + (v.warnings || []).map((w) => `<div class="wf-msg warn">⚠ ${esc(w)}</div>`).join('');
  }
  async function save() {
    try { const r = await api('/api/workflows', { method: 'POST', body: { workflow: W.cur } }); W.cur = clone(r.workflow); W.dirty = false; showValidation({ warnings: r.warnings }); await load(); drawList(); drawRuns(); toast(`Saved (version ${r.workflow.version})`); }
    catch (e) { if (e.body && e.body.validation) showValidation(e.body.validation); else { const v = await api('/api/workflows', { method: 'POST', body: { action: 'validate', workflow: W.cur } }).catch(() => null); if (v) showValidation(v); } fail(e); }
  }
  async function run(test) {
    const v = await api('/api/workflows', { method: 'POST', body: { action: 'validate', workflow: W.cur } }); showValidation(v); if (!v.ok) return;
    const trig = (W.cur.nodes.find((n) => n.type === 'trigger') || {}).config || {};
    let trigger = {};
    if (trig.on === 'task.done' || trig.on === 'task.created') { const t = ((typeof S !== 'undefined' && S.tasks) || [])[0]; trigger = t ? { id: t.id, title: t.title, project: t.meta?.project || t.project, priority: t.meta?.priority || t.priority } : { title: 'Example task', priority: 'high' }; }
    else { const ask = prompt(test ? 'Test input (what would start it, e.g. a task title or a question):' : 'Input for this run (a task title or a question):', ''); if (ask === null) return; trigger = { title: ask, question: ask, text: ask }; }
    if (!test && W.dirty) { await save(); if (W.dirty) return; }
    if (!test && !confirm(`Run "${W.cur.name}" for real? Agents may start, and tasks, memories or notifications may be created.`)) return;
    try {
      const r = await api('/api/workflows', { method: 'POST', body: { action: test ? 'test' : 'run', workflow: test ? W.cur : undefined, id: test ? undefined : W.cur.id, trigger } });
      W.lastRun = r.run; await load(); drawCanvas(); drawRuns();
      toast(`${test ? 'Test' : 'Run'}: ${r.run.status}${r.run.error ? ' (' + r.run.error + ')' : ''}`);
    } catch (e) { fail(e); }
  }

  function drawRuns() {
    const box = document.querySelector('#wf-runs'); if (!box) return;
    const runs = (W.data.runs || []).filter((r) => (W.cur && W.cur.id ? r.workflow === W.cur.id : !W.cur));
    const show = W.lastRun ? [W.lastRun, ...runs.filter((r) => r.id !== W.lastRun.id)] : runs;
    box.innerHTML = show.slice(0, 8).map((r) => `<details class="wf-run" ${r === W.lastRun || r.status === 'waiting' ? 'open' : ''}><summary><b>${esc(r.status)}</b>${r.test ? ' · test' : ''} · ${esc(r.name)} · ${timeAgo(r.started)}</summary>
      ${r.error ? `<div class="wf-msg err">${esc(r.error)}</div>` : ''}
      ${(r.steps || []).map((s) => `<div class="wf-step"><span class="${s.ok ? 'ok' : 'no'}">${s.ok ? '✓' : '✗'}</span><div><b>${esc(s.node)}</b> ${esc(s.note || '')}${s.output ? `<div class="muted">${esc(String(s.output).slice(0, 240))}</div>` : ''}</div></div>`).join('')}
      ${r.status === 'waiting' ? `<div class="in-row" style="margin-top:6px"><button class="btn sm" data-ap="${esc(r.id)}">Approve</button><button class="btn sm ghost" data-rj="${esc(r.id)}">Reject</button></div>` : ''}
      ${['running', 'waiting'].includes(r.status) ? `<button class="btn sm ghost" data-cx="${esc(r.id)}" style="margin-top:6px">Cancel</button>` : ''}</details>`).join('') || '<div class="small muted">No runs yet. Press Test to try it for free.</div>';
    const act = async (action, id) => { try { const r = await api('/api/workflows', { method: 'POST', body: { action, run: id } }); W.lastRun = r.run; await load(); drawCanvas(); drawRuns(); toast(r.run.status); } catch (e) { fail(e); } };
    box.querySelectorAll('[data-ap]').forEach((b) => (b.onclick = () => act('approve', b.dataset.ap)));
    box.querySelectorAll('[data-rj]').forEach((b) => (b.onclick = () => act('reject', b.dataset.rj)));
    box.querySelectorAll('[data-cx]').forEach((b) => (b.onclick = () => act('cancel', b.dataset.cx)));
  }
})();
