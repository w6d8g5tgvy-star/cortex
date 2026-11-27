#!/bin/bash
# Cortex cloud server: run Cortex on an always-on Linux server (Ubuntu/Debian), so your phone and computers can open
# it even when your own computers are off. Paste this one line into the server's terminal:
#   curl -fsSL https://raw.githubusercontent.com/w6d8g5tgvy-star/cortex/main/installers/install-cortex-server.sh | bash
# What it does (asks before each step that needs you):
#   1. installs Node.js, Git and Cortex (into ~/Cortex-app), and runs Cortex as a service that starts at boot
#   2. Cloud sync: links the server to your PRIVATE vault repository with its own SSH "deploy key" (you add the key on
#      GitHub once; the server never gets your GitHub password)
#   3. Tailscale Funnel: gives the server a permanent https:// address (you approve it in your Tailscale account)
#   4. prints a one-time link to pair your phone
# AI agents (Claude Code, Codex) don't run on the server; it hosts the dashboard and your memory. Agents keep running
# on your computers, which connect to the same Cortex through Cloud sync.
set -e
ask() { local q="$1" d="$2" a; read -r -p "$q" a </dev/tty || true; echo "${a:-$d}"; }
say() { echo; echo "== $1"; }
[ "$(id -u)" = "0" ] && { echo "Run this as your normal user (not root); it uses sudo when needed."; exit 1; }
APP="$HOME/Cortex-app"; VAULT="$HOME/Cortex"; PORT=7777

say "1/4 Installing Node.js, Git and Cortex"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates >/dev/null
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
NODE="$(command -v node)"
TMPD="$(mktemp -d)"; curl -fsSL https://codeload.github.com/w6d8g5tgvy-star/cortex/tar.gz/refs/heads/main | tar -xz -C "$TMPD"
mkdir -p "$APP" && cp -R "$TMPD"/cortex-main/. "$APP"/ && rm -rf "$TMPD"
mkdir -p "$VAULT/.cortex"

say "2/4 Cloud sync (your private vault repository)"
REPO=$(ask "SSH address of your private vault repo (e.g. git@github.com:you/cortex-vault.git), or Enter to skip: " "")
if [ -n "$REPO" ]; then
  KEY="$HOME/.ssh/cortex_vault"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "cortex-server" -f "$KEY"
  mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/config"
  grep -q "cortex_vault" "$HOME/.ssh/config" || printf '\nHost github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> "$HOME/.ssh/config"
  ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
  SLUG=$(echo "$REPO" | sed -E 's#^git@github.com:##; s#\.git$##')
  echo; echo "Add this key to your vault repo so the server can sync it:"
  echo "  1. Open https://github.com/$SLUG/settings/keys/new"
  echo "  2. Title: Cortex server. Paste the key below. Tick \"Allow write access\". Click Add key."
  echo; cat "$KEY.pub"; echo
  ask "Press Enter after adding the key... " "" >/dev/null
  "$NODE" -e "const s=require('$APP/src/settings');const c=s.load('$VAULT');s.save('$VAULT',{...c,remote:{...c.remote,enabled:true},cloudSync:{...c.cloudSync,enabled:true,remote:process.argv[1],device:'Cloud server'}})" "$REPO"
  "$NODE" -e "require('$APP/src/cloudsync').sync('$VAULT',{remote:process.argv[1],device:'Cloud server'}).then(r=>console.log('Synced: '+r.changed.length+' file(s) came in'),e=>{console.error('Sync problem: '+e.message);process.exit(1)})" "$REPO" || echo "  (Cloud sync will keep retrying in the background.)"
else
  "$NODE" -e "const s=require('$APP/src/settings');const c=s.load('$VAULT');s.save('$VAULT',{...c,remote:{...c.remote,enabled:true}})"
fi

say "Starting Cortex as a service"
sudo tee /etc/systemd/system/cortex.service >/dev/null <<UNIT
[Unit]
Description=Cortex
After=network-online.target
Wants=network-online.target
[Service]
User=$USER
Environment=CORTEX_VAULT=$VAULT
ExecStart=$NODE $APP/bin/cortex.js start --port $PORT
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now cortex >/dev/null
sleep 3; curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null && echo "Cortex is running." || echo "Cortex didn't answer yet; check: sudo journalctl -u cortex"

say "3/4 A permanent https address (Tailscale Funnel)"
if [ "$(ask "Set up Tailscale now? [Y/n] " "y")" != "n" ]; then
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  echo "Open the link Tailscale prints and sign in with your Tailscale account (the same one as your PC):"
  sudo tailscale up --hostname cortex-cloud
  sudo tailscale funnel --bg "$PORT" || echo "  Funnel needs to be allowed in your Tailscale admin console (it shows a link); then run: sudo tailscale funnel --bg $PORT"
  DNS=$(tailscale status --json | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch{}})")
  URL="https://$DNS"
fi

say "4/4 Pair your phone"
"$NODE" "$APP/bin/cortex.js" pair --vault "$VAULT" ${URL:+--url "$URL"}
echo "Your Cortex: ${URL:-http://<this server>:$PORT}"
echo "Make another pairing code any time: node ~/Cortex-app/bin/cortex.js pair --url ${URL:-<address>}"
echo "Updates install themselves. To stop Cortex: sudo systemctl stop cortex"
