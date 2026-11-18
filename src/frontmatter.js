'use strict';
// Minimal YAML front-matter parser/serializer (the subset Obsidian notes use).

function splitList(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseValue(raw) {
  const v = String(raw).trim();
  if (v === '') return '';
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitList(inner).map(parseValue) : [];
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
  return v;
}

function parse(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/) || line.match(/^\s*-$/);
    if (item && lastKey) {
      if (!Array.isArray(meta[lastKey])) meta[lastKey] = [];
      if (item[1] !== undefined) meta[lastKey].push(parseValue(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      meta[lastKey] = parseValue(kv[2]);
    }
  }
  return { meta, body: text.slice(m[0].length).replace(/^\r?\n/, '') };
}

function fmt(v) {
  if (Array.isArray(v)) return '[' + v.map(fmt).join(', ') + ']';
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (
    s === '' ||
    /^\s|\s$/.test(s) ||
    /[:#\[\]{},&*!|>'"%@`\n\\]/.test(s) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s) ||
    s.startsWith('-')
  ) return JSON.stringify(s);
  return s;
}

function stringify(meta, body) {
  const lines = [];
  for (const [k, v] of Object.entries(meta || {})) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${fmt(v)}`);
  }
  let b = String(body || '');
  if (b && !b.endsWith('\n')) b += '\n';
  return `---\n${lines.join('\n')}\n---\n\n${b}`;
}

module.exports = { parse, stringify };
