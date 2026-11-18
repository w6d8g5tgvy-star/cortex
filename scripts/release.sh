#!/usr/bin/env bash
# Publish a new Cortex version so every install updates itself.
# Usage: scripts/release.sh 1.2.0 "What changed"
# Needs: git repo pushed to GitHub + GitHub CLI (gh) logged in.
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:?usage: scripts/release.sh <version> [notes]}"
NOTES="${2:-}"
node -e "const f='package.json',p=require('./'+f);p.version='$V';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
npm test
git add -A && git commit -m "Release v$V" && git push
# Attach a tarball + checksum so installs can verify the download
mkdir -p .update/dist && tar czf ".update/dist/cortex-$V.tar.gz" --exclude=.git --exclude=.update -C .. "$(basename "$PWD")"
(cd .update/dist && sha256sum "cortex-$V.tar.gz" > "cortex-$V.sha256")
gh release create "v$V" ".update/dist/cortex-$V.tar.gz" ".update/dist/cortex-$V.sha256" --title "Cortex $V" --notes "${NOTES:-Cortex $V}"
echo "✓ Released v$V. Running copies of Cortex will install it automatically within a few hours."
