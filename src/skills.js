'use strict';
// Skills library. Each skill is a Markdown file in <vault>/skills/<slug>.md (front-matter: title, description).
// Cortex can install it as an Agent Skill (<slug>/SKILL.md) for Claude Code and Codex, export a .zip for
// claude.ai (Settings → Capabilities → Skills → Upload), produce paste-ready instructions for ChatGPT
// (Custom GPT / Project instructions), and serve it to any MCP-connected AI through skill_list / skill_get.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TARGETS = {
  'claude-code': { label: 'Claude Code', dir: () => path.join(os.homedir(), '.claude', 'skills') },
  codex: { label: 'Codex', dir: () => path.join(os.homedir(), '.codex', 'skills') },
};

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function skillMd(rec, maxDesc = 1024) {
  const desc = oneLine(rec.meta.description || rec.title).replace(/"/g, "'").slice(0, maxDesc);
  return `---\nname: ${rec.slug}\ndescription: "${desc}"\n---\n\n${String(rec.body || '').trim()}\n`;
}

function targetFile(target, slug) {
  const t = TARGETS[target];
  if (!t) throw new Error(`Unknown target "${target}"`);
  return path.join(t.dir(), slug, 'SKILL.md');
}

// Cortex only ever ADDS skills to Claude Code / Codex. A skill folder Cortex created carries a
// .cortex-managed marker; anything without it belongs to you and is never overwritten or removed.
const MARKER = '.cortex-managed';
const managed = (dir) => fs.existsSync(path.join(dir, MARKER));

function status(rec) {
  const out = {};
  for (const k of Object.keys(TARGETS)) {
    const f = targetFile(k, rec.slug);
    const dir = path.dirname(f);
    let state = 'not installed';
    if (fs.existsSync(f)) {
      if (!managed(dir)) state = 'yours'; // a skill you added yourself (or imported from) — Cortex leaves it alone
      else state = fs.readFileSync(f, 'utf8') === skillMd(rec) ? 'installed' : 'outdated';
    }
    out[k] = state;
  }
  return out;
}

function install(rec, target) {
  const f = targetFile(target, rec.slug);
  const dir = path.dirname(f);
  if (fs.existsSync(dir) && !managed(dir)) {
    throw new Error(`${TARGETS[target].label} already has its own skill named "${rec.slug}". Cortex never overwrites skills you added yourself. Rename this skill in Cortex to add it alongside.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARKER), `Installed by Cortex from skills/${rec.slug}.md. Safe for Cortex to update.\n`);
  fs.writeFileSync(f, skillMd(rec));
  return { target, file: f };
}

/** Only removes skills Cortex itself added. Your own skills are never touched. */
function uninstall(rec, target) {
  const dir = path.dirname(targetFile(target, rec.slug));
  if (!fs.existsSync(dir)) return { target, removed: false };
  if (!managed(dir)) throw new Error(`"${rec.slug}" in ${TARGETS[target].label} was not added by Cortex, so Cortex will not remove it.`);
  fs.rmSync(path.join(dir, 'SKILL.md'), { force: true });
  fs.rmSync(path.join(dir, MARKER), { force: true });
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* keep anything else in the folder */ }
  return { target, removed: true };
}

/** Bring skills that already exist in Claude Code / Codex into the Cortex library. */
function importFrom(store, target) {
  const dir = TARGETS[target] && TARGETS[target].dir();
  if (!dir || !fs.existsSync(dir)) return { imported: [], skipped: [] };
  const { parse } = require('./frontmatter');
  const imported = [];
  const skipped = [];
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    if (managed(path.join(dir, name)) || store.get('skills/' + name)) { skipped.push(name); continue; }
    const { meta, body } = parse(fs.readFileSync(f, 'utf8'));
    const title = String(meta.name || name).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    // imported skills are reference copies: they stay owned by the app they came from
    const rec = store.create('skill', { title, description: meta.description || '', body, source: target, reference: true });
    imported.push(rec.id);
  }
  return { imported, skipped };
}

function chatgptText(rec) {
  return `# Skill: ${rec.title}\n${rec.meta.description ? `Use this when: ${oneLine(rec.meta.description)}\n` : ''}\n${String(rec.body || '').trim()}\n`;
}

// ---- tiny zip writer (deflate) ----
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of files) {
    const raw = Buffer.from(data);
    const comp = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26);
    locals.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}
// claude.ai: zip must contain the skill folder at its root; name ≤ 64 chars, description ≤ 200 chars.
const skillZip = (rec) => zip([{ name: `${rec.slug}/SKILL.md`, data: skillMd(rec, 200) }]);

function seed(store) {
  const marker = path.join(store.vault, '.cortex', 'skills-seeded');
  if (fs.existsSync(marker)) return;
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'claude-code', 'SKILL.md'), 'utf8');
    const { meta, body } = require('./frontmatter').parse(src);
    if (!store.get('skills/cortex')) store.create('skill', { title: 'Cortex', description: meta.description, body });
  } catch { /* optional */ }
  fs.writeFileSync(marker, new Date().toISOString());
}

module.exports = { TARGETS, skillMd, status, install, uninstall, importFrom, chatgptText, skillZip, zip, seed };
