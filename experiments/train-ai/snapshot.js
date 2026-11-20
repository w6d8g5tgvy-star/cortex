#!/usr/bin/env node
'use strict';
// Build a test vault from the user's real Cortex vault: the knowledge a real agent would find.
// Copies projects, project notes and system notes for the suite's projects, plus skills.
// Leaves out: train-ai (it holds this experiment), tasks, mind, fetcher reports and .cortex (settings, tokens).
//   node experiments/train-ai/snapshot.js --from C:/Users/me/Cortex --to C:/Users/me/Cortex-train/snapshot-r0
const fs = require('fs');
const path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg('from');
const TO = arg('to');
const PROJECTS = (arg('projects', 'cortex,roblox-games,skyblock-macros,fetcher')).split(',');
if (!FROM || !TO) { console.error('--from and --to are required'); process.exit(2); }
if (fs.existsSync(TO)) { console.error('target exists; pick a new folder'); process.exit(2); }
const copy = (rel) => { const s = path.join(FROM, rel); if (fs.existsSync(s)) fs.cpSync(s, path.join(TO, rel), { recursive: true }); };
fs.mkdirSync(path.join(TO, 'notes'), { recursive: true });
for (const p of PROJECTS) { copy(path.join('projects', p + '.md')); copy(path.join('notes', p)); }
for (const f of fs.readdirSync(path.join(FROM, 'notes'), { withFileTypes: true })) if (f.isFile()) copy(path.join('notes', f.name));
copy('skills');
let n = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else n++; } })(TO);
console.log(`snapshot ${TO}: ${n} files`);
