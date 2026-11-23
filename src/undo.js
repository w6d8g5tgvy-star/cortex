'use strict';
// Universal undo (2.2 #29): every change to a task, memory or project (create, edit, move, delete) and every settings
// change records the exact previous content, so it can be put back. What cannot be undone is said plainly:
// actions outside Cortex (code an agent changed — use SmartSave restore for that —, pushes, messages already sent).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 256 * 1024; const KEEP = 500;
const file = (vault) => path.join(vault, '.cortex', 'undo.jsonl');
let suspend = false; // while undoing, don't record the undo itself as a new change

function record(vault, entry) {
  if (suspend) return null;
  try {
    const e = { id: 'u-' + crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), ...entry };
    if (e.before && e.before.length > MAX_BYTES) { e.before = null; e.tooLarge = true; }
    fs.mkdirSync(path.dirname(file(vault)), { recursive: true });
    fs.appendFileSync(file(vault), JSON.stringify(e) + '\n');
    const st = fs.statSync(file(vault));
    if (st.size > 8 * 1024 * 1024) { const lines = fs.readFileSync(file(vault), 'utf8').trim().split('\n').slice(-KEEP); fs.writeFileSync(file(vault), lines.join('\n') + '\n'); }
    return e;
  } catch { return null; }
}
function list(vault, limit = 30) {
  try { return fs.readFileSync(file(vault), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.undone).reverse().slice(0, limit).map(({ before, ...e }) => ({ ...e, canUndo: !e.tooLarge })); } catch { return []; }
}
function markUndone(vault, id) {
  const lines = fs.readFileSync(file(vault), 'utf8').trim().split('\n').map((l) => { const e = JSON.parse(l); if (e.id === id) e.undone = new Date().toISOString(); return JSON.stringify(e); });
  fs.writeFileSync(file(vault), lines.join('\n') + '\n');
}

/** Put a change back. */
function undo(store, id) {
  const all = fs.readFileSync(file(store.vault), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const e = all.find((x) => x.id === id);
  if (!e || e.undone) throw new Error('Nothing to undo with that id');
  if (e.tooLarge) throw new Error('That change was too large to keep a copy of. Use the note\'s version history instead.');
  suspend = true;
  try {
    if (e.kind === 'settings') { require('./settings').save(store.vault, JSON.parse(e.before)); }
    else if (e.op === 'create') { if (store.get(e.itemId)) store.remove(e.itemId); }
    else if (e.op === 'delete') { const dest = store.fileOf(e.itemId); if (fs.existsSync(dest)) throw new Error('Something new already exists there'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(e.trash, dest); store.scan(false); }
    else if (e.op === 'update') {
      if (e.afterId && e.afterId !== e.itemId && store.get(e.afterId)) { fs.rmSync(store.fileOf(e.afterId), { force: true }); }
      const dest = store.fileOf(e.itemId); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.before); store.scan(false);
    } else throw new Error('Unknown change');
    markUndone(store.vault, id);
    return { undone: id, what: e.summary };
  } finally { suspend = false; }
}

const CANNOT = ['Code or files an agent changed in your project folders (restore those from SmartSave versions instead)', 'Git pushes, releases and anything already sent to GitHub', 'Messages already delivered to other agents or apps', 'Money already spent on AI usage'];

module.exports = { record, list, undo, CANNOT, isSuspended: () => suspend };
