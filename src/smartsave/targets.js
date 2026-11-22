'use strict';
// Backup targets: where SmartSave copies the (already encrypted) objects and snapshots, away from this computer.
// Every target stores the same keys: "objects/<aa>/<id>" and "snapshots/<workspace>/<id>.json".
//   folder  - a USB/NAS drive or a cloud-synced folder (OneDrive, Google Drive, Dropbox). Cortex can only confirm the
//             copy reached the folder, not that the sync app uploaded it.
//   s3      - any S3-compatible storage you own (Cloudflare R2, Backblaze B2, AWS S3, MinIO). Signed with AWS SigV4.
//   cortex  - your main Cortex, from a paired computer (uses that computer's device key).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeAtomic } = require('./repo');

const KEY_RE = /^(objects\/[a-f0-9]{2}\/[a-f0-9]{64}|snapshots\/[\w-]{1,80}\/[\w-]{1,80}\.json)$/;
const checkKey = (k) => { if (!KEY_RE.test(k)) throw new Error('bad storage key'); return k; };

class FolderTarget {
  constructor({ dir }) { if (!dir) throw new Error('Choose a folder'); this.dir = path.resolve(dir); this.kind = 'folder'; }
  f(k) { return path.join(this.dir, 'cortex-smartsave', ...checkKey(k).split('/')); }
  async has(k) { try { return fs.statSync(this.f(k)).size > 0; } catch { return false; } }
  async put(k, buf) { writeAtomic(this.f(k), buf); }
  async get(k) { return fs.readFileSync(this.f(k)); }
  async list(prefix) {
    const base = path.join(this.dir, 'cortex-smartsave', ...prefix.split('/').filter(Boolean));
    const out = [];
    const walk = (d, rel) => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { if (x.isDirectory()) walk(path.join(d, x.name), rel + x.name + '/'); else if (!x.name.endsWith('.tmp')) out.push(prefix.replace(/\/?$/, '/') + rel + x.name); } };
    walk(base, '');
    return out;
  }
  async test() { fs.mkdirSync(path.join(this.dir, 'cortex-smartsave'), { recursive: true }); const k = path.join(this.dir, 'cortex-smartsave', '.write-test'); fs.writeFileSync(k, 'ok'); fs.rmSync(k); return { ok: true }; }
}

// ---------- S3-compatible (AWS Signature Version 4, no SDK) ----------
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
class S3Target {
  constructor({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 needs endpoint, bucket, access key and secret');
    this.endpoint = String(endpoint).replace(/\/+$/, ''); this.bucket = bucket; this.region = region || 'auto';
    this.ak = accessKeyId; this.sk = secretAccessKey; this.prefix = String(prefix || 'cortex-smartsave').replace(/^\/+|\/+$/g, ''); this.kind = 's3';
  }
  async req(method, key, { body, query = {} } = {}) {
    const u = new URL(this.endpoint);
    const p = '/' + [this.bucket, ...(key ? (this.prefix + '/' + key).split('/') : [])].map(enc).join('/');
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payload = body ? sha256hex(body) : sha256hex('');
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const headers = { host: u.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
    const signed = Object.keys(headers).sort();
    const canon = [method, p, qs, signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payload].join('\n');
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canon)].join('\n');
    const kSign = hmac(hmac(hmac(hmac('AWS4' + this.sk, day), this.region), 's3'), 'aws4_request');
    const auth = `AWS4-HMAC-SHA256 Credential=${this.ak}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${crypto.createHmac('sha256', kSign).update(sts).digest('hex')}`;
    const h = { ...headers, Authorization: auth }; delete h.host;
    const r = await fetch(`${u.origin}${p}${qs ? '?' + qs : ''}`, { method, headers: h, body, signal: AbortSignal.timeout(60000) });
    return r;
  }
  async has(k) { const r = await this.req('HEAD', checkKey(k)); if (r.status === 404) return false; if (!r.ok) throw new Error(`storage said ${r.status}`); return true; }
  async put(k, buf) { const r = await this.req('PUT', checkKey(k), { body: buf }); if (!r.ok) throw new Error(`upload failed: ${r.status} ${(await r.text()).slice(0, 160)}`); }
  async get(k) { const r = await this.req('GET', checkKey(k)); if (!r.ok) throw new Error(`download failed: ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
  async list(prefix) {
    const out = []; let token;
    do {
      const q = { 'list-type': '2', prefix: this.prefix + '/' + prefix, ...(token ? { 'continuation-token': token } : {}) };
      const r = await this.req('GET', '', { query: q });
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      const x = await r.text();
      for (const m of x.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(m[1].slice(this.prefix.length + 1));
      token = (x.match(/<NextContinuationToken>([^<]+)</) || [])[1];
    } while (token);
    return out;
  }
  async test() { const k = 'snapshots/_test/write-test.json'; await this.put(k, Buffer.from('ok')); const back = await this.get(k); return { ok: back.toString() === 'ok' }; }
}

// ---------- the main Cortex, from a paired computer ----------
class CortexTarget {
  constructor({ hub, token }) { if (!hub || !token) throw new Error('Not paired with a main Cortex'); this.hub = String(hub).replace(/\/+$/, ''); this.token = token; this.kind = 'cortex'; }
  async req(method, k, body) {
    const r = await fetch(`${this.hub}/api/runner/smartsave/${checkKey(k)}`, { method, headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(60000) });
    return r;
  }
  async has(k) { const r = await this.req('HEAD', k); if (r.status === 404) return false; if (!r.ok) throw new Error(`main Cortex said ${r.status}`); return true; }
  async put(k, buf) { const r = await this.req('PUT', k, buf); if (!r.ok) throw new Error(`upload failed: ${r.status}`); }
  async get(k) { const r = await this.req('GET', k); if (!r.ok) throw new Error(`download failed: ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
  async list() { throw new Error('not supported'); }
  async test() { return { ok: true }; }
}

function make(t, secrets = {}) {
  if (t.type === 'folder') return new FolderTarget({ dir: t.dir });
  if (t.type === 's3') return new S3Target({ ...t, secretAccessKey: secrets[t.id] || t.secretAccessKey });
  if (t.type === 'cortex') return new CortexTarget(t);
  throw new Error(`Unknown backup target type "${t.type}"`);
}

module.exports = { FolderTarget, S3Target, CortexTarget, make, KEY_RE };
