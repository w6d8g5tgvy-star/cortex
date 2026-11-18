#!/usr/bin/env bash
# Linux: set everything up, then start Cortex with the phone QR code.
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Install Node.js 18+ from https://nodejs.org first."; exit 1; }
node bin/cortex.js setup "$@" && exec node bin/cortex.js start --open-settings
