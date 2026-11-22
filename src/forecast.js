'use strict';
// Usage forecasting (2.2 #32): measured token burn, measured limits where the tool reports them (Codex), a projection
// of when a limit is reached at the current pace, typical cost per task by model, and cheaper alternatives.
// Claude Code does not write quota numbers, so its limit is shown as "not reported" — never guessed.
function forecast(store, sessionList, now = Date.now()) {
  const u = require('./usage').report(sessionList, { now });
  const out = { at: new Date(now).toISOString(), tools: {}, perTask: {}, warnings: [], suggestions: [] };
  for (const k of ['claude', 'codex']) {
    const t = u[k]; if (!t) continue;
    const w = t.windows || {};
    const perHour = w.h5 && w.h5.total ? Math.round(w.h5.total / 5) : w.h1 ? w.h1.total : 0;
    const f = { label: t.label, found: t.found, tokensLastHour: w.h1 ? w.h1.total : 0, tokensToday: w.d1 ? w.d1.total : 0, perHour, limit: null };
    const lim = t.limits;
    if (lim && lim.primary && lim.primary.windowMinutes && lim.primary.resetsAt) {
      const p = lim.primary; const resets = Date.parse(p.resetsAt); const elapsedMin = p.windowMinutes - Math.max(0, (resets - now) / 60000);
      const ratePerMin = elapsedMin > 5 ? p.usedPercent / elapsedMin : null;
      const minsToFull = ratePerMin && ratePerMin > 0 ? (100 - p.usedPercent) / ratePerMin : null;
      const full = minsToFull !== null ? now + minsToFull * 60000 : null;
      f.limit = { source: 'measured (Codex log)', usedPercent: p.usedPercent, resetsAt: p.resetsAt, checkedAt: lim.checkedAt, projectedFullAt: full && full < resets ? new Date(full).toISOString() : null, willLast: full === null || full >= resets };
      if (f.limit.projectedFullAt) out.warnings.push(`At the current pace Codex reaches its limit around ${new Date(full).toLocaleTimeString()}, before it resets.`);
      if (p.usedPercent >= 75) out.suggestions.push('Codex is above 75%: send new work to Claude for now (the router does this automatically in "Choose automatically" mode).');
    } else f.limit = { source: k === 'claude' ? 'not reported by Claude Code' : 'not reported yet', usedPercent: null };
    out.tools[k] = f;
  }
  for (const n of u.notices || []) out.warnings.push(`${n.agent || n.tool}: ${n.message}`);
  try {
    for (const p of require('./intel').profiles(store)) if (p.avgOutputTokens.source === 'measured' || p.avgCost.source === 'measured') out.perTask[p.agent] = { avgOutputTokens: p.avgOutputTokens, avgCost: p.avgCost, runs: p.successRate.n };
  } catch { /* optional */ }
  const opus = Object.entries(out.perTask).find(([k]) => /opus/.test(k));
  if (opus && out.tools.claude && out.tools.claude.tokensToday > 2e6) out.suggestions.push('Heavy Claude use today: small tasks (typos, docs, renames) can run on Haiku; the router picks it for those.');
  return out;
}
module.exports = { forecast };
