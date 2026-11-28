'use strict';
// Minimal Azure Cosmos DB (NoSQL) client over the REST API, no npm packages.
// Auth: Microsoft Entra token from the App Service managed identity (no keys exist in production), or, for local
// development against the emulator only, a master key (COSMOS_KEY).
const crypto = require('crypto');

const API_VERSION = '2018-12-31';

/** Entra token for Cosmos from the App Service managed identity endpoint (cached until shortly before expiry). */
function identityTokenSource({ resource = 'https://cosmos.azure.com', env = process.env } = {}) {
  let cached = null;
  return async () => {
    if (cached && cached.exp - 120000 > Date.now()) return cached.token;
    if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER) throw new Error('No managed identity here (IDENTITY_ENDPOINT/IDENTITY_HEADER missing). Turn on the Web App\'s system-assigned identity.');
    const url = `${env.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
    const r = await fetch(url, { headers: { 'X-IDENTITY-HEADER': env.IDENTITY_HEADER } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Managed identity token failed (HTTP ${r.status})`);
    const exp = Number(j.expires_on) ? Number(j.expires_on) * 1000 : Date.now() + 50 * 60000;
    cached = { token: j.access_token, exp };
    return cached.token;
  };
}

function masterKeyAuth(key, verb, resourceType, resourceLink, date) {
  const text = `${verb.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(text).digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

class Cosmos {
  constructor({ endpoint, database, key, tokenSource, fetchImpl } = {}) {
    if (!endpoint) throw new Error('COSMOS_ENDPOINT is not set');
    this.endpoint = endpoint.replace(/\/+$/, ''); this.db = database || 'cortex'; this.key = key || null;
    this.token = tokenSource || (key ? null : identityTokenSource()); this.fetch = fetchImpl || fetch;
  }

  async request(verb, resourceType, resourceLink, path, { body, headers = {}, okStatuses = [] } = {}) {
    const date = new Date().toUTCString();
    const auth = this.key ? masterKeyAuth(this.key, verb, resourceType, resourceLink, date) : encodeURIComponent(`type=aad&ver=1.0&sig=${await this.token()}`);
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetch(`${this.endpoint}/${path}`, { method: verb, headers: { Authorization: auth, 'x-ms-date': date, 'x-ms-version': API_VERSION, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': headers['Content-Type'] || 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      if (r.status === 429 && attempt < 8) { const wait = Number(r.headers.get('x-ms-retry-after-ms')) || 200 * (attempt + 1); await new Promise((res) => setTimeout(res, wait)); continue; } // throttled: wait as told
      const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
      if (!r.ok && !okStatuses.includes(r.status)) { const e = new Error(`Cosmos ${verb} ${path}: HTTP ${r.status} ${(j && (j.message || j.code)) || ''}`.trim()); e.status = r.status; throw e; }
      return { status: r.status, json: j, headers: r.headers, charge: Number(r.headers.get('x-ms-request-charge')) || 0 };
    }
  }

  docsLink(container) { return `dbs/${this.db}/colls/${container}`; }

  async upsert(container, doc, partitionKey) {
    const link = this.docsLink(container);
    return (await this.request('POST', 'docs', link, `${link}/docs`, { body: doc, headers: { 'x-ms-documentdb-is-upsert': 'true', 'x-ms-documentdb-partitionkey': JSON.stringify([partitionKey]) } })).json;
  }

  async read(container, id, partitionKey) {
    const link = `${this.docsLink(container)}/docs/${encodeURIComponent(id)}`;
    const r = await this.request('GET', 'docs', link, link, { headers: { 'x-ms-documentdb-partitionkey': JSON.stringify([partitionKey]) }, okStatuses: [404] });
    return r.status === 404 ? null : r.json;
  }

  async delete(container, id, partitionKey) {
    const link = `${this.docsLink(container)}/docs/${encodeURIComponent(id)}`;
    const r = await this.request('DELETE', 'docs', link, link, { headers: { 'x-ms-documentdb-partitionkey': JSON.stringify([partitionKey]) }, okStatuses: [404] });
    return r.status !== 404;
  }

  /** SQL query across partitions, following continuation tokens. */
  async query(container, sql, parameters = []) {
    const link = this.docsLink(container); const out = []; let cont = null;
    do {
      const r = await this.request('POST', 'docs', link, `${link}/docs`, { body: { query: sql, parameters }, headers: { 'Content-Type': 'application/query+json', 'x-ms-documentdb-isquery': 'true', 'x-ms-documentdb-query-enablecrosspartition': 'true', 'x-ms-max-item-count': '200', ...(cont ? { 'x-ms-continuation': cont } : {}) } });
      out.push(...((r.json && r.json.Documents) || [])); cont = r.headers.get('x-ms-continuation');
    } while (cont);
    return out;
  }
}

module.exports = { Cosmos, identityTokenSource, masterKeyAuth, API_VERSION };
