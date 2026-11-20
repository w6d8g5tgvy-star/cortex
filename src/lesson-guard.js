'use strict';
// Lesson safety for Fetcher: every technique learned from the web is checked before agents ever see it.
// Free (no AI): pattern checks only. A technique can be
//   ok          → served normally
//   ask         → served, but marked "ask the user first" (it runs commands, installs things, touches secrets)
//   quarantine  → NOT served to agents; kept in the note's meta for the user to review
// Plus provenance: how many independent sources back it, and the best score it got.

const RULES = [
  // prompt injection: text trying to steer the agent instead of teaching it
  { level: 'quarantine', why: 'tries to override the agent\'s instructions', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i },
  { level: 'quarantine', why: 'talks to the AI about its system prompt or role', re: /\b(reveal|print|show|repeat|output|leak|tell (me|us))\b[^.\n]{0,25}\b(your|the)\s+(system prompt|hidden instructions|developer message)|\byou are now\b|\bact as (an? )?(unfiltered|jailbroken|dan)\b|\bjailbreak/i },
  { level: 'quarantine', why: 'asks to send secrets somewhere', re: /\b(send|post|upload|paste|share|email|exfiltrat\w*)\b[^.\n]{0,60}\b(api[ -]?keys?|tokens?|passwords?|credentials?|\.env|ssh keys?|cookies?|secrets?)\b/i },
  { level: 'quarantine', why: 'pipes a download straight into a shell', re: /\b(curl|wget|iwr|invoke-webrequest)\b[^|\n]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b|\biex\s*\(|invoke-expression|powershell[^\n]{0,30}-e(nc(odedcommand)?)?\s+[a-z0-9+/=]{20,}/i },
  { level: 'quarantine', why: 'destroys files or disables protection', re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\$home)|\bformat\s+[a-z]:|\bdel\s+\/[sq]\b|disable[^.\n]{0,30}\b(defender|antivirus|firewall|smartscreen|sandbox)\b|set-mppreference[^\n]*disable|--dangerously-skip-permissions|chmod\s+-r\s+777\s+\//i },
  // needs the user's OK, but is legitimate advice
  { level: 'ask', why: 'runs commands', re: /`[^`]*\b(npm|npx|pip|pipx|brew|apt(-get)?|winget|choco|cargo|go|docker|git|curl|wget|powershell|bash|sh|node|python)\b[^`]*`|\$\s+[a-z]/i },
  { level: 'ask', why: 'installs a tool or service', re: /\b(install|sign up|subscribe|buy|download)\b/i },
  { level: 'ask', why: 'touches keys, passwords or accounts', re: /\b(api[ -]?keys?|(api|access|auth|bearer|github|personal access|refresh|session)[ -]tokens?|passwords?|credentials?|oauth|billing)\b|\.env\b/i },
];

const RANK = { ok: 0, ask: 1, quarantine: 2 };

/** Check one piece of text. → { level, reasons[] } */
function scan(text) {
  const s = String(text || '');
  let level = 'ok';
  const reasons = [];
  for (const r of RULES) {
    if (r.re.test(s)) {
      if (!reasons.includes(r.why)) reasons.push(r.why);
      if (RANK[r.level] > RANK[level]) level = r.level;
    }
  }
  return { level, reasons };
}

/** Provenance: independent sources (distinct channels/urls) and best score. */
function provenance(t) {
  const srcs = Array.isArray(t.sources) ? t.sources : [];
  const urls = new Set(srcs.map((s) => s.url).filter(Boolean));
  const best = srcs.reduce((m, s) => Math.max(m, Number(s.score) || 0), 0);
  const trust = urls.size >= 2 && best >= 70 ? 'high' : urls.size >= 2 || best >= 80 ? 'medium' : 'low';
  return { sources: urls.size, best, trust };
}

/**
 * Check every technique. Returns { active, quarantined } — active techniques carry `safety` and `trust`
 * fields that lesson text and briefs use. A technique the user approved (`approved: true`) is never quarantined again.
 */
function guard(techs) {
  const active = [];
  const quarantined = [];
  for (const t of techs || []) {
    const r = scan([t.name, t.when, t.do, t.why].join('\n'));
    const p = provenance(t);
    const out = { ...t, safety: t.approved && r.level === 'quarantine' ? 'ask' : r.level, safety_reasons: r.reasons, trust: p.trust };
    if (out.safety === 'quarantine') quarantined.push(out);
    else active.push(out);
  }
  return { active, quarantined };
}

/** Short marker added to a technique line, e.g. " ⚠ ask the user first (runs commands)". */
function marker(t) {
  const bits = [];
  if (t.safety === 'ask') bits.push(`⚠ ask the user first (${(t.safety_reasons || []).slice(0, 2).join(', ')})`);
  if (t.trust === 'low') bits.push('single source: verify before relying on it');
  return bits.length ? ` [${bits.join('; ')}]` : '';
}

module.exports = { scan, provenance, guard, marker, RULES };
