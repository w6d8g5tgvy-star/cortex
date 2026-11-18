#!/bin/bash
# macOS: double-click once to set everything up, then Cortex opens with the phone QR code.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js is required" message "Install Node.js 18 or newer from https://nodejs.org, then double-click Setup Cortex again."'
  open "https://nodejs.org"; exit 1
fi
node bin/cortex.js setup && node bin/cortex.js start --open-settings
