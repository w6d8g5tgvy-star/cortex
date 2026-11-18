#!/usr/bin/env bash
# Linux: start Cortex and open the dashboard.
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Install Node.js 18+ from https://nodejs.org first."; exit 1; }
exec node bin/cortex.js start --open "$@"
