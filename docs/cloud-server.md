# Run Cortex on a cloud server (open it even when your computers are off)

Cortex normally runs on your own computer, so it can only be opened while that computer is on. A small always-on
cloud server fixes that: it runs Cortex all the time, your phone and computers open it from anywhere, and Cloud sync
keeps it identical to the Cortex on your computers.

Cortex never signs up for or buys anything for you. You pick the server; these are good options:

| Option | Cost | Notes |
|---|---|---|
| **Oracle Cloud "Always Free"** | Free (asks for a card to verify you; Always Free servers aren't charged) | An "Ampere A1" or "E2.1.Micro" Ubuntu server is plenty. |
| Google Cloud free tier (e2-micro) | Free within the free-tier limits | Pick a US region that the free tier covers. |
| Hetzner, DigitalOcean, Vultr | about $4–6 a month | The simplest to set up. |

Cortex needs very little: 1 CPU, 1 GB RAM, a few GB of disk, Ubuntu 22.04 or 24.04.

## Steps

1. **Create the server** with your provider (Ubuntu 22.04/24.04). Open its terminal: the provider's browser
   "SSH"/"Cloud Shell" button works, so you don't need anything installed.
2. **Paste this one line** and press Enter:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/w6d8g5tgvy-star/cortex/main/installers/install-cortex-server.sh | bash
   ```
3. When it asks for your vault repository, enter its **SSH** address, e.g. `git@github.com:you/cortex-vault.git`.
   It shows a key: open the link it prints, paste the key, tick **Allow write access**, click **Add key**, then press
   Enter on the server. (This key only works for that one repository. The server never gets your GitHub password.)
4. When it asks about Tailscale, say yes, open the link it prints and sign in with the **same Tailscale account** as
   your PC. If Tailscale says Funnel isn't allowed yet, follow its link to allow it. You get a permanent address like
   `https://cortex-cloud.<your-tailnet>.ts.net`.
5. At the end it prints a **pairing link**: open it on your phone, tap Pair, then **Add to Home Screen**.

Done: `https://cortex-cloud.<your-tailnet>.ts.net` now opens your Cortex any time, and your computers stay in sync
with it through Cloud sync (turn it on in each computer's Settings with the same repository).

## Good to know
- **Updates install themselves** on the server, like on your computers.
- **AI agents** (Claude Code, Codex) still run on your computers; the server hosts the dashboard and your memory.
- **New pairing code** (another phone, or after removing one): on the server run
  `node ~/Cortex-app/bin/cortex.js pair --url https://cortex-cloud.<your-tailnet>.ts.net`
  (add `--computer` for a computer).
- **Stop or remove:** `sudo systemctl disable --now cortex`. Your vault stays in your private repository.
- **Security:** settings, device keys and pairing never leave the server; Funnel traffic is never treated as "this
  computer", so settings that need the main computer can't be changed from the internet.
