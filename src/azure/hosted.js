'use strict';
// Cortex hosted on Azure App Service (CORTEX_STORE=cosmos). Startup: restore the vault from Cosmos DB, apply
// cloud-safe settings, then keep Cosmos up to date while running. Settings that come from the environment (App
// Settings, some of them Key Vault references) win over saved ones.
const os = require('os');
const path = require('path');
const { Cosmos } = require('./cosmos');
const persist = require('./persist');

const isHosted = (env = process.env) => env.CORTEX_STORE === 'cosmos';
const defaultVault = () => path.join(os.tmpdir(), 'cortex-vault'); // fast local working copy; Cosmos is the record

function cosmosFromEnv(env = process.env) {
  return new Cosmos({ endpoint: env.COSMOS_ENDPOINT, database: env.COSMOS_DATABASE || 'cortex', key: env.COSMOS_KEY || undefined }); // COSMOS_KEY: local emulator only
}

/** Restore from Cosmos and make settings safe for a server with no screen. */
async function prepare(vault, { env = process.env, log = console.log, cosmos = cosmosFromEnv(env) } = {}) {
  const t0 = Date.now();
  const { known, files, broken } = await persist.hydrate(cosmos, vault);
  log(`Restored ${files} file(s) from Cosmos DB in ${Date.now() - t0} ms${broken ? ` (${broken} incomplete skipped)` : ''}`);
  const settings = require('../settings');
  const s = settings.load(vault);
  settings.save(vault, {
    ...s,
    remote: { ...s.remote, enabled: true },          // phones and computers reach it over the internet
    screen: { ...s.screen, enabled: false },          // no screen on a server
    updates: { ...s.updates, auto: false },           // new versions arrive through GitHub Actions, not the self-updater
    ...(env.CORTEX_CONNECTOR_TOKEN ? { connector: { ...s.connector, token: env.CORTEX_CONNECTOR_TOKEN } } : {}),
  });
  return { cosmos, known, files };
}

module.exports = { isHosted, defaultVault, cosmosFromEnv, prepare, startPersistence: persist.startPersistence };
