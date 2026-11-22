#!/usr/bin/env node
'use strict';
// Resource benchmark: idle CPU and memory of a running Cortex, and dashboard API latency (p50/p95).
// Usage: node experiments/smartsave/bench.js [--smartsave] [--seconds 20] [--files 400]
// With --smartsave, a project with N files is enabled for SmartSave, so idle and active costs can be compared.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', 20));
const FILES = Number(arg('files', 400));
const WITH = process.argv.includes('--smartsave');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clk = Number(execFileSync('getconf', ['CLK_TCK']).toString()) || 100;
const procStat = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return { cpu: (Number(f[11]) + Number(f[12])) / clk, rss: Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024 }; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-v-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-p-'));
  for (let i = 0; i < FILES; i++) { const d = path.join(proj, 'src', 'm' + (i % 20)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `f${i}.js`), `// file ${i}\n` + 'export const x = 1;\n'.repeat(40 + (i % 50))); }
  fs.mkdirSync(path.join(vault, '.cortex'), { recursive: true });
  const { Store } = require(ROOT + '/src/store');
  const st = new Store(vault);
  for (let i = 0; i < 60; i++) st.create('note', { title: 'Note ' + i, body: 'Some text about topic ' + i });
  st.create('project', { title: 'Bench', folder: proj });
  if (WITH) fs.writeFileSync(path.join(vault, '.cortex', 'settings.json'), JSON.stringify({ smartsave: { enabled: true, projects: { bench: { enabled: true } } } }));
  const port = 45000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [ROOT + '/bin/cortex.js', 'serve', '--vault', vault, '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* starting */ } await sleep(250); }
  await sleep(4000); // let startup work (first scan / first checkpoint) finish
  const a = procStat(srv.pid); const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const b = procStat(srv.pid); const idleSec = (Date.now() - t0) / 1000;
  const lat = {};
  for (const route of ['/api/state', '/api/items?kind=note', '/api/live']) {
    const xs = [];
    for (let i = 0; i < 120; i++) { const s = performance.now(); await (await fetch(base + route)).arrayBuffer(); xs.push(performance.now() - s); }
    lat[route] = { p50: +pct(xs, 50).toFixed(2), p95: +pct(xs, 95).toFixed(2) };
  }
  let active = null;
  if (WITH) {
    // active: change 20 files, wait for the debounced checkpoint, measure CPU used by it
    const c0 = procStat(srv.pid);
    for (let i = 0; i < 20; i++) fs.appendFileSync(path.join(proj, 'src', 'm' + (i % 20), `f${i}.js`), `\n// edit ${Date.now()}\n`);
    const s = Date.now();
    let snaps = 0;
    for (let i = 0; i < 60; i++) { await sleep(1000); const r = await (await fetch(base + '/api/smartsave/status')).json(); snaps = (r.projects && r.projects.bench && r.projects.bench.snapshots) || 0; if (snaps >= 2) break; }
    const c1 = procStat(srv.pid);
    active = { checkpointAfterEditSec: +((Date.now() - s) / 1000).toFixed(1), cpuSecondsForCheckpoint: +(c1.cpu - c0.cpu).toFixed(3), snapshots: snaps, repoBytes: dirSize(path.join(vault, '.cortex', 'smartsave')) };
  }
  srv.kill();
  const out = { smartsave: WITH, files: FILES, idleSeconds: +idleSec.toFixed(1), idleCpuPercent: +(((b.cpu - a.cpu) / idleSec) * 100).toFixed(3), rssMB: +b.rss.toFixed(1), latencyMs: lat, active, node: process.version, cpus: os.cpus().length };
  console.log(JSON.stringify(out, null, 1));
  fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true });
})();
function dirSize(d) { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } } catch { /* none */ } return n; }
