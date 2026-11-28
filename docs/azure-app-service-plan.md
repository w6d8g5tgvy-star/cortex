# Plan: Cortex on Azure App Service + Cosmos DB + Key Vault

Status: **built** on branch `azure-app-service` (tests pass with a fake Cosmos DB; not yet deployed to a real subscription). Decisions taken with the user:
- App Service **Basic B1** (Linux, Always On)
- Sign-in: **Cortex pairing only** (no Entra ID login in front)
- Data: **Cosmos DB for NoSQL** now (free tier), no file vault in Azure
- Deploy: **Bicep + GitHub Actions**
- Topology: **Azure is the main Cortex**; both computers keep a local Markdown copy that syncs with it and run agents
- Subscription: **existing pay-as-you-go** · Region: **West US 2**

## 0. How to set it up (once)
1. Open Azure Cloud Shell (portal.azure.com → `>_` → Bash) and run:
   ```bash
   git clone -b azure-app-service https://github.com/w6d8g5tgvy-star/cortex && cd cortex && bash infra/setup-azure.sh
   ```
   It asks before creating anything, detects whether the Cosmos free tier is still available, deploys `infra/main.bicep`,
   puts the two Cortex secrets in Key Vault, and creates the GitHub deploy identity (OIDC).
2. Add the four repository **variables** it prints in GitHub (Settings → Secrets and variables → Actions → Variables).
3. Run **Actions → Deploy to Azure → Run workflow**. Later releases deploy automatically.
4. On your phone open `<app url>/pair` and enter the owner code it printed.
5. On each computer: pair it as a computer (owner phone → Settings → Devices → Add a computer) and run
   `node bin/cortex.js runner --sync` (or use the installer link). The home PC's first sync uploads your existing vault.

## As built (differences from the first draft)
- Cosmos stores the **vault files themselves** as documents (one container `vault`, partition key `/area`, files split
  into 512 KB parts) instead of three containers with a new data model. Cortex keeps working on a local copy and every
  module works unchanged; Cosmos is the record (restore on start, upload changes every 5 s and on shutdown). A full
  per-item data model can come later without changing the infrastructure.
- Code: `src/azure/cosmos.js` (REST client, managed-identity tokens, no npm packages), `src/azure/persist.js`,
  `src/azure/hosted.js`, owner pairing in `src/devices.js`, `/healthz`, computer sync (`cortex runner --sync`).
- Infra: `infra/main.bicep`, `infra/main.bicepparam`, `infra/setup-azure.sh`; deploy: `.github/workflows/deploy-azure.yml`.
- Tests: `test/azure.js` (fake Cosmos DB + fake managed identity). The Bicep file wasn't compiled in the build
  environment; Azure validates it on the first `az deployment group create`.

## 1. What gets created (one dedicated resource group)

| Resource | Name (suggested) | Setting | Why |
|---|---|---|---|
| Resource group | `rg-cortex` | West US 2 | Everything Cortex in one place; delete it to remove everything |
| App Service plan | `asp-cortex` | Linux, **B1**, 1 instance | Cheapest tier with Always On (sync, timers and live updates keep running) |
| Web App | `app-cortex-<suffix>` | Node 22 LTS, Always On, HTTPS only, FTP off, HTTP/2, health check `/api/health`, **system-assigned managed identity** | Runs Cortex. One instance only: Cortex keeps in-memory state, so no scale-out |
| Cosmos DB account | `cosmos-cortex-<suffix>` | NoSQL API, **free tier on**, local (key) auth **off**, continuous backup 7 days | Database; no keys exist at all, so nothing to leak |
| Cosmos database | `cortex` | **shared 1000 RU/s (manual)** | Exactly the free-tier allowance, so the database stays $0 |
| Key Vault | `kv-cortex-<suffix>` | RBAC mode, soft delete on | Holds Cortex's own secrets (below) |
| (optional) Application Insights | `appi-cortex` | workspace-based | Error/latency monitoring; first 5 GB/month free. Can be added later |

**Access (all identity-based, no passwords):**
- Web App identity → Cosmos **Built-in Data Contributor** (Cosmos data-plane role assignment, done in Bicep)
- Web App identity → Key Vault **Key Vault Secrets User**
- GitHub Actions → **Website Contributor** on the resource group only (code deploys), through OIDC federated credentials (no stored Azure secret)

**Estimated cost:** about **$13/month** (B1 Linux, West US 2) + $0 Cosmos (inside free tier) + a few cents for Key Vault.
Check: the Cosmos free tier is **one account per subscription**; if this pay-as-you-go subscription already used it,
the database costs extra (around $58/month for 1000 RU/s, or switch to *serverless*, which is pay-per-request and
usually cents for one person). The Bicep has a `cosmosFreeTier` switch for this.

## 2. Secrets in Key Vault
Cortex itself has few secrets; with managed identity, Cosmos needs none.
| Secret | Used as App Setting | What it is |
|---|---|---|
| `cortex-connector-token` | `CORTEX_CONNECTOR_TOKEN` | The secret part of the MCP URL used by Claude/ChatGPT connectors |
| `cortex-owner-setup-code` | `CORTEX_OWNER_SETUP_CODE` | One-time code that makes your first phone/computer the **owner** (see §4) |
| `smartsave-key` (later) | `CORTEX_SMARTSAVE_KEY` | Encryption key if SmartSave backups run in Azure |

App Settings point at them with Key Vault references (`@Microsoft.KeyVault(SecretUri=…)`); App Service refreshes
them every 24 h and on restart. Device keys stay hashed in the database, never in Key Vault or in memory notes.

## 3. Data model in Cosmos (one database, three containers)
| Container | Partition key | Holds |
|---|---|---|
| `items` | `/kind` | notes, tasks, projects, Mind items, skills: one document per item = today's Markdown file (front-matter fields + `body`), plus `version` for conflict checks |
| `activity` | `/day` | activity log entries; TTL (e.g. 365 days) so it never grows forever |
| `state` | `/scope` | what lives in `.cortex/` today: settings, devices (hashed keys), pairing codes, sessions, commands, notifications, workflows and runs, chats, undo, file history |

Tiny data set (one person), so cross-partition queries are fine and stay well under 1000 RU/s.
Cortex already loads everything into memory at start; Cosmos becomes the write-through store behind it.

## 4. Changes to Cortex (the real work)
1. **Storage drivers.** Put today's file storage behind a small interface (`get/list/put/delete/query`) and add a
   `cosmos` driver. `CORTEX_STORE=cosmos` picks it. Files stay the default for computers.
2. **Cosmos over HTTPS with no npm packages.** Plain `fetch` to the Cosmos REST API with an Entra token from the App
   Service identity endpoint (`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`, resource `https://cosmos.azure.com`),
   `Authorization: type=aad&ver=1.0&sig=<token>`. Keeps Cortex at zero dependencies. Retries on 429 (throttling).
3. **Hosting mode.** Listen on App Service's `PORT`, bind 0.0.0.0, trust App Service's forwarding headers, turn off
   features that need a desktop (screen view, local file editor/sandbox on this server, Fetcher downloads, starting
   local agents). The dashboard says which features run on your computers instead.
4. **Owner instead of "this computer".** Today some settings only work from the main computer itself (pairing codes,
   phone access, cloud settings). In Azure nothing is "this computer", so: the first device paired with
   `CORTEX_OWNER_SETUP_CODE` becomes **owner** and can do those things; more owners can be added; `cortex pair` also
   works from the App Service SSH console.
5. **Computers sync with Azure.** Each computer pairs once as a *computer* and keeps its Markdown vault. A two-way
   sync over Cortex's existing computer-key API (built on the standby sync: changed files only, both versions kept on
   conflict) every minute and after changes. Works offline and catches up. The Git `cortex-vault` sync stays
   available as an extra backup.
6. **Migration.** `cortex migrate --to azure`: uploads your current vault (from the home PC) into Cosmos once.
7. **Tests.** A fake Cosmos REST server in the test suite (no emulator needed), plus a deploy smoke test that calls
   `/api/health` after each deploy.

## 5. Deployment
- `infra/main.bicep` (+ `main.bicepparam`): everything in §1 and the role assignments.
  **Run once by you** in Azure Cloud Shell (`az deployment group create …`). Infra changes are rare, and this keeps
  GitHub's permissions small.
- `.github/workflows/deploy-azure.yml`: on each Cortex release (push to `main` that changes `release.json`) or by
  hand. It runs the tests, zips the app, `azure/login` with OIDC, then `azure/webapps-deploy` and the health check.
  GitHub needs only three non-secret values (client ID, tenant ID, subscription ID).
- Rollback: redeploy the previous release from the Actions page (or use a staging slot later; slots need Standard).

## 6. Rollout
1. Code: storage interface + Cosmos driver + hosting/owner mode + computer sync, all tested locally (fake Cosmos).
2. You: run the Bicep in Cloud Shell, create the GitHub OIDC credential (a script prints the exact commands).
3. First deploy from GitHub Actions; pair your phone as owner with the setup code.
4. `cortex migrate --to azure` from the home PC; turn on "sync with Azure" on both computers.
5. Watch for a week; then decide on extras (App Insights alerts, backups export, staging slot).

## 7. Risks / things to watch
- **Free tier already used** on this subscription → choose serverless (Bicep switch) to keep the cost tiny.
- **B1 has no staging slots**; deploys restart the app for a few seconds. OK for one person.
- **Single instance**: don't scale out until state moves fully to Cosmos (step 4.1 does most of this).
- **Agents and Fetcher** don't run on App Service; they keep running on your computers (as runners).
- Live updates use server-sent events; Cortex pings every 25 s, inside App Service's 230 s request timeout.

## Sources
- Cosmos DB free tier: https://learn.microsoft.com/azure/cosmos-db/free-tier
- Cosmos DB pricing: https://azure.microsoft.com/pricing/details/cosmos-db/
- Cosmos DB REST access control (type=aad): https://learn.microsoft.com/rest/api/cosmos-db/access-control-on-cosmosdb-resources
- Cosmos DB role-based access with Entra ID: https://learn.microsoft.com/azure/cosmos-db/how-to-setup-rbac
- App Service Linux pricing: https://azure.microsoft.com/pricing/details/app-service/linux/
- Key Vault references in App Service: https://learn.microsoft.com/azure/app-service/app-service-key-vault-references
- Deploy to App Service with GitHub Actions (OIDC): https://learn.microsoft.com/azure/app-service/deploy-github-actions
- GitHub OIDC in Azure: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure
- Azure SQL free offer (alternative considered): https://learn.microsoft.com/azure/azure-sql/database/free-offer
