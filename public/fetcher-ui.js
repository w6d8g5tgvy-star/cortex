'use strict';
/* Fetcher interface layer: a live pipeline that explains which step Fetcher is on, a "scanner" of the
   videos being read and scored, and per-run mini pipelines. It wraps whatever renderFetcher() the
   dashboard has (so newer Fetcher forms keep working) and only reads job data:
   status + step text from /api/fetcher, and the full job from /api/fetcher/job. Zero tokens. */
(function fetcherUI() {
  if (typeof window.renderFetcher !== 'function') return;

  // ---------- the pipeline ----------
  const STAGES = [
    { key: 'plan', label: 'Plan', cost: 'ai-light', icon: '◎', what: 'Turns your request into a few focused YouTube searches (different angles on the topic).' },
    { key: 'search', label: 'Search', cost: 'free', icon: '⌕', what: 'Searches YouTube from each angle and gathers related videos, newest and most relevant first.' },
    { key: 'read', label: 'Read', cost: 'free', icon: '▤', what: 'Downloads each video\'s transcript, chapters and details. Long videos are skimmed in full.' },
    { key: 'precheck', label: 'Pre-check', cost: 'free', icon: '⧖', what: 'A free local filter drops weak or off-topic videos before any AI is spent.' },
    { key: 'review', label: 'Usefulness check', cost: 'ai', icon: '✦', what: 'An AI checker scores how much each shortlisted video would help agents do real tasks, and pulls out techniques.' },
    { key: 'score', label: 'Worth-it score', cost: 'free', icon: '∑', what: 'Cortex calculates the worth-it score itself: 35% impact, 25% how often it applies, 15% confidence, 15% low effort, 10% low risk.' },
    { key: 'teach', label: 'Tryout & teach', cost: 'ai', icon: '⬡', what: 'Tries each worth-it technique on a real task, then saves the good ones as a lesson every agent can use.' },
    { key: 'recall', label: 'Recall check', cost: 'free', icon: '◉', what: 'Confirms agents can actually find the new lesson when they search memory.' },
  ];
  const RUNNING = ['queued', 'searching', 'checking', 'reviewing', 'teaching', 'planning', 'reading', 'skimming', 'tryout'];

  /** Work out where a job is from its status + step text (works with older and newer Fetcher versions). */
  function locate(j) {
    const st = String(j.status || '').toLowerCase();
    const step = String(j.step || '');
    const s = step.toLowerCase();
    const frac = (step.match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
    const pct = frac.length === 2 && frac[1] ? Math.min(1, frac[0] / frac[1]) : null;
    let idx;
    let state = 'active';
    if (st === 'done' || st === 'rejected') {
      idx = STAGES.length; state = 'done';
    } else if (st === 'needs-approval') { idx = 0; state = 'waiting'; }
    else if (st === 'queued') { idx = 0; state = 'waiting'; }
    else if (/plan/.test(s) || st === 'planning') idx = 0;
    else if (st === 'searching' || /search/.test(s)) idx = 1;
    else if (/pre-?check|none of .* passed|shortlist/.test(s)) idx = 3;
    else if (/skim/.test(s) || st === 'skimming' || st === 'reading' || st === 'checking' || /reading video|read/.test(s)) idx = 2;
    else if (/try ?out|trying/.test(s) || st === 'tryout') idx = 6;
    else if (st === 'reviewing' || /checker|review/.test(s)) idx = 4;
    else if (/score/.test(s)) idx = 5;
    else if (st === 'teaching' || /teach|lesson/.test(s)) idx = 6;
    else if (/recall/.test(s)) idx = 7;
    else idx = 0;
    if (st === 'error') state = 'error';
    return { idx, state, pct, frac };
  }

  function stageState(i, loc, j) {
    if (loc.state === 'done') {
      if (i >= 6 && !j.lesson && (j.worth_it || 0) === 0) return 'skipped';
      return 'done';
    }
    if (i < loc.idx) return 'done';
    if (i === loc.idx) return loc.state === 'error' ? 'error' : loc.state === 'waiting' ? 'waiting' : 'active';
    return 'todo';
  }

  const costTag = (c) => (c === 'free' ? '<span class="fxp-cost free">free</span>' : c === 'ai-light' ? '<span class="fxp-cost light">small AI</span>' : '<span class="fxp-cost ai">uses AI</span>');

  function pipelineHtml(j, big) {
    const loc = locate(j);
    const nodes = STAGES.map((st, i) => {
      const s = stageState(i, loc, j);
      return `<div class="fxp-node s-${s}" title="${esc(st.label)}: ${esc(st.what)}">
        <div class="fxp-orb"><span>${s === 'done' ? '✓' : s === 'error' ? '!' : s === 'skipped' ? '–' : st.icon}</span></div>
        <div class="fxp-label">${esc(st.label)}</div>${big ? costTag(st.cost) : ''}</div>`;
    }).join('<div class="fxp-link"><i></i></div>');
    const doneFrac = loc.state === 'done' ? 1 : Math.min(1, (loc.idx + (loc.pct || 0.35)) / STAGES.length);
    return `<div class="fxp ${big ? 'big' : 'mini'}" style="--fxp-progress:${(doneFrac * 100).toFixed(1)}%"><div class="fxp-track"><i></i></div><div class="fxp-row">${nodes}</div></div>`;
  }

  function nowHtml(j) {
    const loc = locate(j);
    if (loc.state === 'done') {
      return `<div class="fxn-title">Finished</div><div class="fxn-what">${esc(j.step || 'Done')}</div>`;
    }
    const st = STAGES[Math.min(loc.idx, STAGES.length - 1)];
    const lead = loc.state === 'waiting' ? (j.status === 'needs-approval' ? 'Waiting for your OK' : 'Queued: starts in a moment')
      : loc.state === 'error' ? 'Stopped with an error' : `Step ${loc.idx + 1} of ${STAGES.length}: ${st.label}`;
    return `<div class="fxn-title">${esc(lead)} ${loc.state === 'active' ? costTag(st.cost) : ''}</div>
      <div class="fxn-what">${esc(st.what)}</div>
      <div class="fxn-live"><span class="fxn-dot"></span>${esc(j.step || '')}</div>
      ${loc.pct != null ? `<div class="fxn-bar"><i style="width:${(loc.pct * 100).toFixed(0)}%"></i></div>` : ''}`;
  }

  // ---------- the scanner (videos as signal nodes on a radar) ----------
  let scan = null;
  function stopScan() { if (scan) { cancelAnimationFrame(scan.raf); scan = null; } }
  function videoState(v, threshold) {
    if (v.taught) return 'taught';
    if (v.score != null) return v.score >= threshold ? 'worth' : v.score >= 45 ? 'maybe' : 'low';
    if (v.error) return 'error';
    if (v.skipped || (v.pre && v.pre.score != null && (v.pre.pass === false || v.pre.score < 25))) return 'dropped';
    if (v.pre && v.pre.score != null) return 'read';
    return 'queued';
  }
  const SCOL = { taught: '#ffffff', worth: '#3ee6a0', maybe: '#ffc35c', low: '#ff6b8a', error: '#ff6b8a', dropped: '#5b6385', read: '#5ce1ff', queued: '#3a4366' };
  function drawScanner(canvas, job, live) {
    stopScan();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r0 = canvas.getBoundingClientRect();
    canvas.width = r0.width * dpr; canvas.height = r0.height * dpr;
    const W = r0.width; const H = r0.height; const cx = W / 2; const cy = H / 2; const R = Math.min(W, H) / 2 - 18;
    const vids = (job && job.videos) || [];
    const th = (job && job.threshold) || 60;
    const nodes = vids.map((v, i) => {
      const ang = (i / Math.max(1, vids.length)) * Math.PI * 2 - Math.PI / 2;
      const st = videoState(v, th);
      const ring = st === 'worth' || st === 'taught' ? 0.45 : st === 'maybe' ? 0.62 : st === 'read' ? 0.8 : st === 'queued' ? 0.95 : 0.88;
      return { x: cx + Math.cos(ang) * R * ring, y: cy + Math.sin(ang) * R * ring, st, v };
    });
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let t = 0;
    scan = { raf: 0 };
    const frame = () => {
      t++;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // rings
      ctx.lineWidth = 1;
      for (const f of [0.45, 0.62, 0.8, 0.95]) { ctx.strokeStyle = f === 0.45 ? 'rgba(62,230,160,.22)' : 'rgba(140,170,255,.12)'; ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, 6.283); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(140,170,255,.08)';
      ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      // sweep
      if (live && !reduce) {
        const a = (t * 0.025) % 6.283;
        const g = ctx.createConicGradient ? ctx.createConicGradient(a - 0.9, cx, cy) : null;
        if (g) {
          g.addColorStop(0, 'rgba(92,225,255,0)'); g.addColorStop(0.13, 'rgba(92,225,255,.20)'); g.addColorStop(0.145, 'rgba(92,225,255,0)'); g.addColorStop(1, 'rgba(92,225,255,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill();
        }
      }
      // links from core to scored videos
      for (const n of nodes) {
        if (!['worth', 'taught', 'maybe'].includes(n.st)) continue;
        const gr = ctx.createLinearGradient(cx, cy, n.x, n.y);
        gr.addColorStop(0, 'rgba(155,123,255,.5)'); gr.addColorStop(1, SCOL[n.st] + '88');
        ctx.strokeStyle = gr; ctx.lineWidth = n.st === 'taught' ? 1.8 : 1; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.stroke();
      }
      // core
      const pulse = reduce ? 1 : 0.85 + 0.15 * Math.sin(t * 0.06);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34 * pulse);
      cg.addColorStop(0, 'rgba(255,255,255,.95)'); cg.addColorStop(0.25, 'rgba(155,123,255,.8)'); cg.addColorStop(1, 'rgba(92,225,255,0)');
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, 34 * pulse, 0, 6.283); ctx.fill();
      // nodes
      for (const n of nodes) {
        const col = SCOL[n.st];
        const rr = n.st === 'worth' || n.st === 'taught' ? 6 : n.st === 'queued' ? 3 : 4.5;
        const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, rr * 3.5);
        glow.addColorStop(0, col); glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = n.st === 'queued' || n.st === 'dropped' ? 0.5 : 1;
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(n.x, n.y, rr * 3.5, 0, 6.283); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, 6.283); ctx.fill();
        if (n.st === 'taught') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(n.x, n.y, rr + 4, 0, 6.283); ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
      if (live && !reduce && scan) scan.raf = requestAnimationFrame(frame);
    };
    frame();
    canvas.onmousemove = (e) => {
      const b = canvas.getBoundingClientRect(); const x = e.clientX - b.left; const y = e.clientY - b.top;
      const hit = nodes.find((n) => Math.hypot(n.x - x, n.y - y) < 10);
      canvas.title = hit ? `${hit.v.title}${hit.v.score != null ? ` · score ${hit.v.score} (${hit.v.verdict})` : hit.v.pre ? ` · pre-check ${hit.v.pre.score}` : ''}` : '';
      canvas.style.cursor = hit ? 'pointer' : 'default';
    };
    canvas.onclick = (e) => {
      const b = canvas.getBoundingClientRect(); const x = e.clientX - b.left; const y = e.clientY - b.top;
      const hit = nodes.find((n) => Math.hypot(n.x - x, n.y - y) < 10);
      if (hit && hit.v.id) window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(hit.v.id)}`, '_blank', 'noopener');
    };
  }

  function legendHtml(job) {
    const vids = (job && job.videos) || [];
    const th = (job && job.threshold) || 60;
    const count = (k) => vids.filter((v) => videoState(v, th) === k).length;
    const item = (k, label) => `<span class="fxl-i"><i style="background:${SCOL[k]};box-shadow:0 0 8px ${SCOL[k]}"></i>${label} <b>${count(k)}</b></span>`;
    return `<div class="fxl">${item('queued', 'waiting')}${item('read', 'read')}${item('dropped', 'dropped (free)')}${item('maybe', 'maybe')}${item('worth', 'worth it')}${item('taught', 'taught')}</div>`;
  }

  // ---------- put it on the page ----------
  async function enhance() {
    if (S.route[0] !== 'fetcher') { stopScan(); return; }
    const data = (typeof FX !== 'undefined' && FX.data) || await api('/api/fetcher').catch(() => null);
    if (!data || !main) return;
    const jobs = data.jobs || [];
    const focus = jobs.find((j) => RUNNING.includes(String(j.status))) || jobs.find((j) => j.status === 'needs-approval') || jobs[0];
    // hero
    let hero = $('#fx-hero');
    if (!hero) {
      hero = document.createElement('div');
      hero.id = 'fx-hero';
      const head = main.querySelector('.page-head');
      if (head) head.after(hero); else main.prepend(hero);
    }
    if (!focus) {
      hero.className = 'fx-hero panel';
      hero.innerHTML = `<div class="fx-hero-empty"><div class="fxn-title">Fetcher is idle</div><div class="fxn-what">Ask it to research a topic below. You'll see each step here as it happens: ${STAGES.map((s) => esc(s.label)).join(' → ')}.</div></div>${pipelineHtml({ status: 'queued', step: '' }, true)}`;
      stopScan();
    } else {
      const live = RUNNING.includes(String(focus.status));
      hero.className = `fx-hero panel ${live ? 'is-live' : ''}`;
      hero.innerHTML = `
        <div class="fx-hero-grid">
          <div class="fx-scan"><canvas id="fx-scan"></canvas><div class="fx-scan-label">${live ? 'SCANNING' : focus.status === 'done' ? 'COMPLETE' : String(focus.status).toUpperCase()}</div></div>
          <div class="fx-hero-main">
            <div class="eyebrow">${live ? 'Live research' : 'Latest research'} · ${esc(focus.from || 'you')}</div>
            <h2 class="fx-topic">${esc(focus.topic)}</h2>
            <div class="fx-now">${nowHtml(focus)}</div>
            <div id="fx-legend"></div>
          </div>
        </div>
        ${pipelineHtml(focus, true)}
        <div class="fx-stage-help">${STAGES.map((s, i) => `<div class="fxh-i ${stageState(i, locate(focus), focus)}"><b>${i + 1}. ${esc(s.label)}</b> ${costTag(s.cost)}<span>${esc(s.what)}</span></div>`).join('')}</div>`;
      // full job for the scanner (video states, threshold)
      api('/api/fetcher/job?id=' + encodeURIComponent(focus.id)).then((full) => {
        if (S.route[0] !== 'fetcher') return;
        const lg = $('#fx-legend'); if (lg) lg.innerHTML = legendHtml(full);
        drawScanner($('#fx-scan'), full, live);
      }).catch(() => drawScanner($('#fx-scan'), { videos: [] }, live));
    }
    // mini pipeline on every run card
    for (const j of jobs) {
      const btn = main.querySelector(`[data-fxopen="${CSS.escape(j.id)}"]`) || main.querySelector(`[data-fxdel="${CSS.escape(j.id)}"]`);
      const card = btn && btn.closest('.fx-job, .panel');
      if (!card || card.querySelector('.fxp.mini')) continue;
      const wrap = document.createElement('div');
      wrap.innerHTML = pipelineHtml(j, false);
      const firstRow = card.querySelector('.row');
      (firstRow || card.firstChild).after(wrap.firstChild);
    }
  }

  const original = window.renderFetcher;
  window.renderFetcher = async function renderFetcherWithPipeline(soft) {
    await original(soft);
    try { await enhance(); } catch (e) { console.warn('Fetcher interface:', e); }
  };
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/fetcher')) stopScan(); });

  // ---------- styles (kept here so this layer is one self-contained file) ----------
  const css = `
  .fx-hero{margin-bottom:18px;position:relative;overflow:hidden}
  .fx-hero::before{content:'';position:absolute;inset:-40% -10% auto auto;width:420px;height:420px;background:radial-gradient(circle,rgba(92,225,255,.10),transparent 65%);pointer-events:none}
  .fx-hero.is-live{border-color:rgba(92,225,255,.35);box-shadow:var(--glow)}
  .fx-hero-grid{display:grid;grid-template-columns:260px 1fr;gap:22px;align-items:center}
  .fx-scan{position:relative;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle at 50% 50%,rgba(40,46,110,.45),rgba(3,5,14,.85) 70%);border:1px solid var(--edge-2);box-shadow:inset 0 0 40px rgba(92,140,255,.15),0 0 30px rgba(92,140,255,.12)}
  .fx-scan canvas{width:100%;height:100%;display:block;border-radius:50%}
  .fx-scan-label{position:absolute;bottom:14%;left:0;right:0;text-align:center;font:600 10.5px var(--mono);letter-spacing:.3em;color:var(--cyan)}
  .fx-topic{margin:4px 0 10px;font-size:24px;letter-spacing:-.02em}
  .fx-now{background:rgba(6,9,22,.45);border:1px solid var(--edge);border-radius:14px;padding:14px 16px}
  :root[data-theme='light'] .fx-now{background:rgba(255,255,255,.6)}
  .fxn-title{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .fxn-what{color:var(--text-2);font-size:13.5px;margin-top:4px}
  .fxn-live{margin-top:8px;font:12.5px var(--mono);color:var(--cyan);display:flex;gap:8px;align-items:center;word-break:break-word}
  .fxn-dot{width:7px;height:7px;border-radius:50%;background:var(--cyan);box-shadow:0 0 10px var(--cyan);flex:none;animation:breathe 1.4s ease-in-out infinite}
  .fxn-bar{height:4px;border-radius:9px;background:rgba(140,160,255,.12);margin-top:10px;overflow:hidden}
  .fxn-bar i{display:block;height:100%;background:var(--aurora);box-shadow:var(--glow-cyan);transition:width .5s var(--ease)}
  .fx-hero-empty{margin-bottom:6px}
  .fxl{display:flex;flex-wrap:wrap;gap:10px 14px;margin-top:12px;font-size:12px;color:var(--text-2)}
  .fxl-i{display:inline-flex;align-items:center;gap:6px}.fxl-i i{width:8px;height:8px;border-radius:50%;display:inline-block}
  .fxp{position:relative;margin-top:18px}
  .fxp.mini{margin:10px 0 2px}
  .fxp-track{position:absolute;left:4%;right:4%;top:17px;height:2px;background:rgba(140,160,255,.14);border-radius:2px}
  .fxp.mini .fxp-track{top:9px}
  .fxp-track i{position:absolute;left:0;top:0;bottom:0;width:var(--fxp-progress);background:var(--aurora);box-shadow:0 0 12px rgba(92,225,255,.6);border-radius:2px;transition:width .6s var(--ease)}
  .is-live .fxp-track i::after{content:'';position:absolute;right:-3px;top:-3px;width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 14px #5ce1ff}
  .fxp-row{position:relative;display:flex;align-items:flex-start;justify-content:space-between}
  .fxp-link{flex:1}
  .fxp-node{display:flex;flex-direction:column;align-items:center;gap:6px;width:92px;text-align:center}
  .fxp.mini .fxp-node{width:auto;flex:0 0 auto}
  .fxp-orb{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:rgba(10,13,32,.8);border:1px solid var(--edge-2);color:var(--text-3);font-size:14px;transition:all .3s var(--ease)}
  .fxp.mini .fxp-orb{width:20px;height:20px;font-size:10px}
  .fxp.mini .fxp-label,.fxp.mini .fxp-cost{display:none}
  .fxp-label{font-size:11.5px;color:var(--text-3);font-weight:600;line-height:1.25}
  .s-done .fxp-orb{background:rgba(62,230,160,.14);border-color:rgba(62,230,160,.55);color:var(--ok)}
  .s-done .fxp-label{color:var(--text-2)}
  .s-active .fxp-orb{background:var(--aurora);border-color:transparent;color:#fff;box-shadow:0 0 0 4px rgba(92,225,255,.15),0 0 24px rgba(92,225,255,.6);animation:fxpulse 1.6s ease-in-out infinite}
  .s-active .fxp-label{color:var(--text)}
  .s-waiting .fxp-orb{border-color:rgba(255,195,92,.6);color:var(--warn);box-shadow:0 0 16px rgba(255,195,92,.3)}
  .s-error .fxp-orb{border-color:var(--bad);color:var(--bad);box-shadow:0 0 16px rgba(255,107,138,.4)}
  .s-skipped .fxp-orb{opacity:.45}
  @keyframes fxpulse{50%{box-shadow:0 0 0 8px rgba(92,225,255,.05),0 0 34px rgba(92,225,255,.8)}}
  .fxp-cost{font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:1px 6px;border-radius:99px}
  .fxp-cost.free{color:var(--ok);background:rgba(62,230,160,.1)}
  .fxp-cost.ai{color:var(--violet);background:rgba(155,123,255,.14)}
  .fxp-cost.light{color:var(--cyan);background:rgba(92,225,255,.1)}
  .fx-stage-help{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:16px}
  .fxh-i{font-size:12px;color:var(--text-3);padding:8px 10px;border-radius:12px;border:1px solid var(--edge);background:rgba(8,11,26,.25);display:flex;flex-direction:column;gap:3px}
  :root[data-theme='light'] .fxh-i{background:rgba(255,255,255,.5)}
  .fxh-i b{color:var(--text-2);font-size:12px;display:flex;gap:6px;align-items:center}
  .fxh-i .fxp-cost{align-self:flex-start}
  .fxh-i.active{border-color:rgba(92,225,255,.45);box-shadow:0 0 18px rgba(92,225,255,.12)}.fxh-i.active b{color:var(--text)}
  .fxh-i.done b{color:var(--ok)}
  @media (max-width:1100px){.fx-stage-help{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:760px){
    .fx-hero-grid{grid-template-columns:1fr}.fx-hero-main{order:-1}.fx-scan{max-width:180px;margin:14px auto 0}
    .fxp.big .fxp-row{overflow-x:auto;padding-bottom:6px}.fxp.big .fxp-node{width:74px;flex:none}.fxp.big .fxp-link{min-width:8px}
    .fxp.big .fxp-track{display:none}.fx-stage-help{grid-template-columns:1fr}
  }`;
  const style = document.createElement('style');
  style.id = 'fetcher-ui-css';
  style.textContent = css;
  document.head.appendChild(style);
})();


// ---------- quarantined lesson techniques: review panel on the Fetcher page ----------
(() => {
  const orig = window.renderFetcher;
  if (typeof orig !== 'function') return;
  window.renderFetcher = async function (...a) {
    const r = await orig.apply(this, a);
    try {
      if (S.route[0] !== 'fetcher' || document.getElementById('qz-panel')) return r;
      const d = await api('/api/lessons/quarantine');
      const n = d.lessons.reduce((s, l) => s + l.items.length, 0);
      if (!n) return r;
      const head = document.querySelector('#main .page-head');
      const p = document.createElement('div');
      p.className = 'panel warn-panel'; p.id = 'qz-panel'; p.style.marginBottom = '16px';
      p.innerHTML = `<h3>⚠ ${n} technique${n === 1 ? '' : 's'} blocked by the safety check</h3><p class="small muted" style="margin-top:0">Fetcher keeps advice away from agents when it looks like an attempt to steer them, leak secrets, or run something dangerous. Review it here: approve it (agents then see it marked "ask the user first") or discard it.</p>` +
        d.lessons.map((l) => l.items.map((t) => `<div class="jb" style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--edge);border-radius:12px;margin-top:8px"><div style="flex:1;min-width:0"><b>${esc(t.name)}</b> <span class="small muted">in ${esc(l.title)}</span><div class="small" style="margin:4px 0">${esc(String(t.do || '').slice(0, 400))}</div><div class="small" style="color:var(--warn)">Why blocked: ${esc(t.reasons.join(', ') || 'unknown')}</div>${t.sources.length ? `<div class="small muted">From: ${t.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(', ')}</div>` : ''}</div><div style="display:flex;gap:6px;flex-shrink:0"><button class="btn sm" data-qz="approve" data-id="${esc(l.id)}" data-name="${esc(t.name)}">Approve</button><button class="btn sm danger" data-qz="discard" data-id="${esc(l.id)}" data-name="${esc(t.name)}">Discard</button></div></div>`).join('')).join('');
      if (document.getElementById('qz-panel') || S.route[0] !== 'fetcher') return r; // a second render finished first
      if (head && head.nextSibling) head.parentNode.insertBefore(p, head.nextSibling); else document.querySelector('#main').prepend(p);
      p.querySelectorAll('[data-qz]').forEach((b) => (b.onclick = async () => {
        if (b.dataset.qz === 'approve' && !confirm('Approve this technique? Agents will see it, marked "ask the user first".')) return;
        try { await api('/api/lessons/quarantine', { method: 'POST', body: { id: b.dataset.id, name: b.dataset.name, action: b.dataset.qz } }); toast(b.dataset.qz === 'approve' ? 'Approved' : 'Discarded'); p.remove(); window.renderFetcher(); } catch (e) { fail(e); }
      }));
    } catch (e) { console.warn('quarantine panel', e); }
    return r;
  };
})();
