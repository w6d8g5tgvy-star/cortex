'use strict';
// Keep secrets out of what Cortex writes on its own (agent journals, activity log). Agents and hooks pass free text
// (an agent's final reply, a summary) that can contain the phone pairing link, the connector link or an API key;
// those files are plain Markdown/JSON that sync, back up and get searched. Found on 2026-11-20: the journal had
// copied the phone pairing token from two assistant replies.
const fs = require('fs');
const path = require('path');

// Cortex's own secrets for this vault (pairing token, connector secret), cached briefly.
let cache = { vault: null, at: 0, list: [] };
function ownSecrets(vault) {
  if (!vault) return [];
  if (cache.vault === vault && Date.now() - cache.at < 30000) return cache.list;
  let list = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(vault, '.cortex', 'settings.json'), 'utf8'));
    list = [s.remote && s.remote.token, s.connector && s.connector.token].filter((t) => typeof t === 'string' && t.length >= 12);
  } catch { /* no settings yet */ }
  cache = { vault, at: Date.now(), list };
  return list;
}

const PATTERNS = [
  [/([?&#](?:token|access_token|api_key|apikey|key|secret|password|pwd)=)[^\s&#)"'`<>\]]+/gi, '$1<redacted>'], // secrets in URLs
  [/(\/mcp\/)[A-Za-z0-9_-]{12,}/g, '$1<secret>'], // Cortex connector secret link
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1<redacted>'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '<redacted-api-key>'], // Anthropic / OpenAI style keys
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '<redacted-github-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '<redacted-github-token>'],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}/g, '<redacted-slack-token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>'],
];

/** Text with secrets replaced by placeholders. `vault` adds this vault's own tokens (matched anywhere). */
function redact(text, vault) {
  let s = String(text == null ? '' : text);
  for (const t of ownSecrets(vault)) s = s.split(t).join('<redacted>');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

module.exports = { redact, _resetCache: () => { cache = { vault: null, at: 0, list: [] }; } };
