#!/usr/bin/env bash
# Rebuild and republish the GitHub Pages copy by hand.
# Only needed until .github/build.yml is installed as a real workflow.
set -euo pipefail
cd "$(dirname "$0")"
root=$(pwd)
export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"

node test.mjs
node build.mjs

tmp=$(mktemp -d)
cp dist/index.html "$tmp/index.html"
touch "$tmp/.nojekyll"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="tony8713" -c user.email="tony@bonustrack.co" \
    commit -q -m "publish $(date -u +%FT%TZ)"
git push -qf "https://github.com/snapshot-labs/pr-dashboard.git" gh-pages
cd "$root"
rm -rf "$tmp"
echo "published gh-pages"
