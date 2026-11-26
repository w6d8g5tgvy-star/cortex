#!/bin/bash
# Cortex installer for Linux. Run: bash install-cortex.sh Safe to run again (it updates Cortex).
HUB=""; CODE=""; MODE="main"; STANDBY="0"
APP="$HOME/Cortex-app"; RUNNER="$HOME/.cortex-runner"
fail() { echo; echo "  $1"; true; read -r -p "Press Enter to close" _; exit 1; }
echo; echo "  Installing Cortex. This takes a few minutes; keep this window open."; echo
if [ "$MODE" = "computer" ]; then
  echo "[1/4] Pairing this computer with your main Cortex..."
  mkdir -p "$RUNNER"
  NAME="$(hostname)"
  curl -s -f -X POST "$HUB/api/pair" -H "Content-Type: application/json" -d "{\"code\":\"$CODE\",\"name\":\"$NAME\",\"platform\":\"linux $NAME\",\"format\":\"runner-config\",\"hub\":\"$HUB\"}" -o "$RUNNER/config.json" || fail "Pairing failed: the code may have expired or your main computer is off. Make a new code in Cortex: Settings, Devices, Add a computer."
  chmod 600 "$RUNNER/config.json"
fi
echo "[2/4] Checking Node.js..."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then echo "  Installing Node.js (asks for your password)..."; sudo apt-get update -qq && sudo apt-get install -y -qq nodejs; fi
fi
command -v node >/dev/null 2>&1 || fail "Node.js could not be installed automatically. Install the LTS version from https://nodejs.org, then run this again."
NODE="$(command -v node)"
echo "[3/4] Downloading Cortex..."
TMPD="$(mktemp -d)"
curl -L -f -s "https://codeload.github.com/w6d8g5tgvy-star/cortex/tar.gz/refs/heads/main" | tar -xz -C "$TMPD" || fail "Download failed. Check your internet connection and run this again."
mkdir -p "$APP" && cp -R "$TMPD/cortex-main/." "$APP/" && rm -rf "$TMPD"
[ -f "$APP/bin/cortex.js" ] || fail "Cortex could not be put in place at $APP."
echo "[4/4] Setting up..."
if [ "$MODE" != "computer" ]; then
  "$NODE" "$APP/bin/cortex.js" setup
  nohup "$NODE" "$APP/bin/cortex.js" start --open-settings >/dev/null 2>&1 &
  echo; echo "  Done. Cortex is open in your browser and starts by itself when you sign in."; sleep 5; exit 0
fi
ARGS="runner"; [ "$STANDBY" = "1" ] && ARGS="runner --standby"
mkdir -p "$HOME/.config/autostart"
printf '[Desktop Entry]\nType=Application\nName=Cortex runner\nExec=%s %s %s\nX-GNOME-Autostart-enabled=true\n' "$NODE" "$APP/bin/cortex.js" "$ARGS" > "$HOME/.config/autostart/cortex-runner.desktop"
nohup "$NODE" "$APP/bin/cortex.js" $ARGS >"$RUNNER/runner.log" 2>&1 &
REMOVE="delete ~/.config/autostart/cortex-runner.desktop and remove the computer in Cortex (Settings, Devices)"
echo
if [ "$STANDBY" = "1" ]; then echo "  Done. This computer is connected to your main Cortex and keeps a standby copy: if the main computer is off, Cortex opens here at http://localhost:7777"; else echo "  Done. This computer is connected to your main Cortex and can run agent jobs."; fi
echo "  It starts by itself when you sign in. To remove it: $REMOVE."
read -r -p "Press Enter to close" _
