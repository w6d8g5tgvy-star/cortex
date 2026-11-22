'use strict';
// Universal command center + natural-language settings (2.2 #19, #41). Plain English → a concrete Cortex action.
// Deterministic (no AI tokens). Anything sensitive returns a proposal the user confirms first; the existing pages and
// settings keep working as before.

const num = (s) => { const m = String(s).match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

/** Parse a request. Returns { intent, params, confirm, summary } or { intent: 'unknown', suggestions }. */
function parse(text, { projects = [] } = {}) {
  const t = String(text || '').trim();
  const l = t.toLowerCase();
  const findProject = () => {
    const ps = [...projects].sort((a, b) => b.title.length - a.title.length);
    return ps.find((p) => l.includes(p.title.toLowerCase()) || l.includes(p.slug)) || null;
  };
  const P = findProject();
  let m;
  if (/^(stop|halt|kill)\b.*\b(all|every|everything)\b|^emergency stop|^stop everything/.test(l)) return { intent: 'emergency-stop', params: {}, confirm: true, summary: 'Stop every running agent, job and Fetcher research now' };
  if ((m = t.match(/^(?:start|create|new|make)\s+(?:a\s+)?(?:new\s+)?project\s+(?:called|named)?\s*["“]?(.+?)["”]?$/i))) return { intent: 'create-project', params: { title: m[1].trim() }, confirm: false, summary: `Create the project "${m[1].trim()}"` };
  if (/^(continue|resume|pick up)\b/.test(l)) return { intent: 'continue', params: { project: P && P.slug }, confirm: true, summary: P ? `Continue the latest saved work in ${P.title}` : 'Continue your most recent work' };
  if ((m = t.match(/^(?:research|look into|find out about|learn about)\s+(.+)$/i))) return { intent: 'research', params: { topic: m[1].trim(), project: P && P.slug }, confirm: true, summary: `Ask Fetcher to research "${m[1].trim()}" (uses some AI)` };
  if ((m = t.match(/^(?:launch|start|run|send)\s+(?:an?\s+)?(?:agent|claude|codex)\s+(?:to\s+)?(.+)$/i)) || (m = t.match(/^(?:have|get)\s+(?:an?\s+)?(?:agent|claude|codex)\s+(?:to\s+)?(.+)$/i))) {
    const tool = /codex/.test(l) ? 'codex' : 'claude';
    const on = (l.match(/\bon (?:my |the )?([\w' -]+?)(?: computer| pc| laptop)?$/) || [])[1];
    return { intent: 'launch', params: { prompt: m[1].replace(/\s+on (my |the )?[\w' -]+?( computer| pc| laptop)?$/i, '').trim(), project: P && P.slug, tool, computer: on && !/^this$/.test(on) ? on : null }, confirm: true, summary: `Start ${tool === 'codex' ? 'Codex' : 'Claude Code'}${on ? ` on ${on}` : ''}: ${m[1].trim()}` };
  }
  if (/\b(improve|boost|make)\b.*\b(ai|agents?)\b.*\b(better|performance|smarter)?/.test(l) && /improve|better|smarter|performance/.test(l)) return { intent: 'improve', params: {}, confirm: false, summary: 'Look for recurring mistakes and propose tested improvements' };
  if (/\b(connect|pair|add)\b.*\b(phone|computer|laptop|device|pc)\b/.test(l)) return { intent: 'connect-device', params: { kind: /computer|laptop|pc/.test(l) ? 'computer' : 'phone' }, confirm: false, summary: `Pair a ${/computer|laptop|pc/.test(l) ? 'computer' : 'phone'}` };
  if (/\b(fix|repair|troubleshoot|diagnose)\b|not working|broken|can'?t connect|won'?t connect|disconnected/.test(l) && /\b(connection|connector|connect\w*|broken|problem|health|not working|cortex|agent|phone|device|sync|backup)\b/.test(l)) return { intent: 'troubleshoot', params: {}, confirm: false, summary: 'Check Cortex\'s health and offer fixes' };
  if (/save (every|interval)|save .*every \d+|every \d+ (min|sec|hour)/.test(l) && num(l)) return { intent: 'setting', params: { smartsave: { intervalSec: Math.round(num(l) * (/hour/.test(l) ? 3600 : /sec/.test(l) ? 1 : 60)) } }, confirm: true, summary: `SmartSave at least every ${num(l)} ${/hour/.test(l) ? 'hour(s)' : /sec/.test(l) ? 'seconds' : 'minute(s)'} while files change` };
  if ((m = t.match(/^(?:save|checkpoint|back ?up)\b\s*(.*)$/i)) && !/setting/.test(l)) return { intent: 'save', params: { project: P && P.slug }, confirm: false, summary: P ? `Save a SmartSave checkpoint of ${P.title} now` : 'Save every SmartSave project now' };
  if ((m = t.match(/^(?:find|search(?: for)?|where is|look for)\s+(.+)$/i))) return { intent: 'search', params: { q: m[1].trim() }, confirm: false, summary: `Search for "${m[1].trim()}"` };
  if (/\b(organi[sz]e|clean ?up|tidy)\b/.test(l)) return { intent: 'organize', params: { project: P && P.slug }, confirm: false, summary: 'Find duplicates, outdated notes and loose ends (suggestions only)' };
  // ---- settings in plain English (always shown first, then confirmed) ----
  const on = /\b(turn on|enable|switch on|allow|start)\b/.test(l); const off = /\b(turn off|disable|switch off|stop|don'?t allow|block)\b/.test(l);
  if ((on || off) && /phone access|phone/.test(l)) return setting({ remote: { enabled: on && !off } }, `${on && !off ? 'Allow' : 'Stop'} phone access`);
  if ((on || off) && /auto.?updat|updates/.test(l)) return setting({ updates: { auto: on && !off } }, `${on && !off ? 'Turn on' : 'Turn off'} automatic updates`);
  if ((on || off) && /screen/.test(l)) return setting({ screen: { enabled: on && !off } }, `${on && !off ? 'Share' : 'Stop sharing'} this computer's screen on the Live page`);
  if ((on || off) && /smart ?save|autosave|auto.?save/.test(l)) return { intent: 'setting', params: { smartsave: { enabled: on && !off, project: P && P.slug } }, confirm: true, summary: `${on && !off ? 'Turn on' : 'Turn off'} SmartSave${P ? ` for ${P.title}` : ''}` };
  if ((on || off) && /starting agents|agent control|launch(ing)? agents/.test(l)) return setting({ agents: { enabled: on && !off } }, `${on && !off ? 'Allow' : 'Stop'} Cortex from starting agents`);
  if (/\b(simple|basic) mode\b/.test(l) || /\badvanced mode\b/.test(l)) return { intent: 'ui-mode', params: { mode: /advanced/.test(l) ? 'advanced' : 'simple' }, confirm: false, summary: `Switch to ${/advanced/.test(l) ? 'Advanced' : 'Simple'} mode` };
  return { intent: 'unknown', suggestions: ['start a project called Website', 'continue my work on Shop', 'research faster test runs', 'launch an agent to fix the login bug', 'connect my phone', 'fix connection problems', 'find apple pay', 'turn on phone access', 'stop all agents'] };
  function setting(patch, summary) { return { intent: 'setting', params: patch, confirm: true, summary }; }
}

module.exports = { parse };
