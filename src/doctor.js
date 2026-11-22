'use strict';
// Automatic troubleshooting (2.2 #25): find what's broken, explain it in plain words, and offer safe one-click fixes.
// Every fix only repeats something Cortex already does elsewhere (re-install its own hooks, restart its own link,
// retry its own uploads, re-detect agent tools) — never touches the user's files or other apps' settings.
const fs = require('fs');
const os = require('os');
const path = require('path');

async function diagnose({ vault, store, conf, runner, tunnel, smart, claudeHooks, updater }) {
  const c = conf(); const out = [];
  const add = (id, area, ok, problem, explain, fix) => out.push({ id, area, ok, problem: ok ? null : problem, explain: ok ? null : explain, fix: ok ? null : fix || null });
  // agents
  let av = {}; try { av = await runner.available(); } catch { /* ignore */ }
  const anyTool = Object.values(av).some((x) => x.installed);
  add('agent-tools', 'Agents', anyTool, 'Neither Claude Code nor Codex was found on this computer.', 'Cortex starts agents with these programs. Install one (or set its path in Settings → Agent control), then press Check again.', { action: 'agents.recheck', label: 'Check again' });
  if (c.agents.enabled) add('agent-folder', 'Agents', (c.agents.folders || []).some((f) => fs.existsSync(f)), 'No allowed folder exists for agents to work in.', 'Agents may only work inside folders you allow. Add your code folder in Settings → Agent control.', null);
  // hooks (live view, recall, SmartSave triggers)
  let hs = { installed: false }; try { hs = claudeHooks.status(); } catch { /* ignore */ }
  if (av.claude && av.claude.installed) add('hooks', 'Integrations', hs.installed, 'Claude Code isn\'t reporting to Cortex (hooks missing).', 'Without the hooks, the Live page, memory recall and SmartSave checkpoints before context compaction don\'t run for sessions you start yourself.', { action: 'hooks.repair', label: 'Re-install Cortex hooks' });
  // connector link
  if (c.connector.tunnel) { const t = tunnel.status(); add('connector', 'Connection', !!(t.url || t.running), 'The link that Claude/ChatGPT use to reach Cortex is down.', t.error ? `It reported: ${String(t.error).slice(0, 160)}` : 'The connector tunnel is not running, so AI apps outside this computer cannot reach Cortex.', { action: 'tunnel.restart', label: 'Restart the link' }); }
  // storage
  let writable = true; try { const f = path.join(vault, '.cortex', '.doctor-write'); fs.writeFileSync(f, 'ok'); fs.rmSync(f); } catch { writable = false; }
  add('vault-write', 'Storage', writable, 'Cortex cannot write to its vault folder.', `The folder ${vault} is read-only or the disk is full. Memories and tasks can't be saved until this is fixed.`, null);
  try { const s = fs.statfsSync ? fs.statfsSync(vault) : null; if (s) { const freeGB = (s.bavail * s.bsize) / 1e9; add('disk', 'Storage', freeGB > 1, `Only ${freeGB.toFixed(2)} GB free on the disk holding the vault.`, 'Saves, backups and SmartSave checkpoints may start failing. Free some space.', null); } } catch { /* not supported */ }
  // backups
  try {
    const st = smart.ss.state();
    for (const t of (c.smartsave.targets || [])) { const ts = st.targets[t.id] || {}; add(`backup-${t.id}`, 'Backups', !(ts.lastError && (ts.failures || 0) >= 2), `SmartSave can't upload to "${t.name || t.type}".`, `Last error: ${ts.lastError || ''}. Saves are kept on this computer and will upload when it works again.`, { action: 'smartsave.retry', label: 'Retry now' }); }
  } catch { /* smartsave off */ }
  // paired computers
  try { for (const d of require('./devices').list(vault).filter((x) => x.kind === 'computer')) add(`device-${d.id}`, 'Devices', d.online, `"${d.name}" is offline.`, `It was last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never'}. Jobs for it wait until its runner is started again (node bin/cortex.js runner on that computer).`, null); } catch { /* ignore */ }
  // updates
  try { const pend = updater.readPending(); add('update', 'Updates', !(pend && pend.rolledBack), 'The last update failed and was rolled back.', `Cortex went back to ${pend && pend.from}. Your data is safe. It will try the next version automatically.`, { action: 'update.check', label: 'Check for updates' }); } catch { /* ignore */ }
  // memory health (existing check)
  try { const weak = require('./insights').health(store).filter((p) => p.score < 60); add('memory', 'Memory', weak.length === 0, `${weak.length} project${weak.length === 1 ? '' : 's'} need attention (${weak.map((p) => p.title).slice(0, 3).join(', ')}).`, weak.flatMap((p) => p.issues).slice(0, 3).join(' '), null); } catch { /* ignore */ }
  return { ok: out.every((x) => x.ok), checks: out, at: new Date().toISOString(), platform: `${os.platform()} ${os.release()}` };
}

async function fix(action, { vault, runner, tunnel, smart, claudeHooks, checkUpdates }) {
  if (action === 'agents.recheck') return { done: true, result: await runner.available() };
  if (action === 'hooks.repair') { const r = claudeHooks.install({ vault }); return { done: !!r.ok, result: r }; }
  if (action === 'tunnel.restart') { try { await tunnel.stop(); } catch { /* not running */ } return { done: true, result: await tunnel.start() }; }
  if (action === 'smartsave.retry') { const s = smart.ss.state(); for (const t of Object.values(s.targets)) t.nextTry = 0; smart.ss.saveState(s); return { done: true, result: await smart.ss.uploadPending({ maxMs: 30000 }) }; }
  if (action === 'update.check') return { done: true, result: await checkUpdates() };
  throw new Error('Unknown fix');
}

module.exports = { diagnose, fix };
