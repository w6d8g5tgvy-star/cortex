'use strict';
// App settings stored in <vault>/.cortex/settings.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');

const DEFAULTS = () => ({
  updates: { auto: true, source: (pkg.cortex && pkg.cortex.updateSource) || '', checkHours: 6 },
  remote: { enabled: false, token: '' },
  screen: { enabled: false, watch: [] },
  agents: { enabled: false, folders: [], permission: 'acceptEdits', maxMinutes: 120, saveGate: true, phoneApprovals: false, approvalWaitSeconds: 120, instructions: '' },
  connector: { token: '', tunnel: false, provider: 'cloudflare', lastUrl: '' },
  search: { semantic: true, model: 'nomic-embed-text' },
  backups: { daily: true },
});

function file(vault) { return path.join(vault, '.cortex', 'settings.json'); }

function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

function load(vault) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(vault), 'utf8')); } catch { /* defaults */ }
  const s = merge(DEFAULTS(), saved);
  let dirty = false;
  if (!s.remote.token) { s.remote.token = newToken(); dirty = true; }
  if (!s.connector.token) { s.connector.token = newToken(); dirty = true; }
  if (dirty) save(vault, s);
  return s;
}

function save(vault, s) {
  fs.mkdirSync(path.dirname(file(vault)), { recursive: true });
  const tmp = file(vault) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file(vault));
  return s;
}

function update(vault, patch) { return save(vault, merge(load(vault), patch)); }

function newToken() { return crypto.randomBytes(18).toString('base64url'); }

module.exports = { load, save, update, newToken };
