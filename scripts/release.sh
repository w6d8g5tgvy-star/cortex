#!/usr/bin/env bash
# Publish a new Cortex version. Every running copy finds it within a few hours and updates itself.
# Usage: scripts/release.sh 1.3.0 "What changed"
# How it works: bumps package.json, runs the tests, writes release.json and pushes main.
# Cortex reads release.json and downloads https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/main
# (no GitHub Release or tag needed; release.json and package.json change in the same commit).
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:?usage: scripts/release.sh <version> [notes]}"
NOTES="${2:-Cortex $V}"
node -e "const f='package.json',p=require('./'+f);p.version='$V';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
node -e "require('fs').writeFileSync('release.json',JSON.stringify({version:'$V',branch:'main',url:'https://codeload.github.com/'+require('child_process').execSync('git remote get-url origin').toString().trim().replace(/^.*github\.com[:/]/,'').replace(/\.git$/,'')+'/tar.gz/refs/heads/main',notes:process.argv[1],date:new Date().toISOString()},null,2)+'\n')" "$NOTES"
npm test
git add -A && git commit -m "Release v$V"
git push origin HEAD:main
git tag "v$V" && git push origin "v$V" || echo "(tag not pushed; not needed for updates)"
echo "✓ Released v$V. Running copies of Cortex will install it automatically within a few hours."
