#!/usr/bin/env bash
# Publish a new Cortex version. Every running copy finds it within a few hours and updates itself.
# Usage: scripts/release.sh 1.3.0 "What changed"
# How it works: bumps package.json, runs the tests, writes release.json, tags v<version>, pushes.
# Cortex downloads https://codeload.github.com/<owner>/<repo>/tar.gz/refs/tags/v<version> (no GitHub Release needed).
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:?usage: scripts/release.sh <version> [notes]}"
NOTES="${2:-Cortex $V}"
node -e "const f='package.json',p=require('./'+f);p.version='$V';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
node -e "require('fs').writeFileSync('release.json',JSON.stringify({version:'$V',notes:process.argv[1],date:new Date().toISOString()},null,2)+'\n')" "$NOTES"
npm test
git add -A && git commit -m "Release v$V"
git tag "v$V"
git push origin HEAD "v$V"
echo "✓ Released v$V. Running copies of Cortex will install it automatically within a few hours."
