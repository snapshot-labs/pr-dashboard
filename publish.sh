#!/usr/bin/env bash
# Rebuild and republish the GitHub Pages copy.
#
# Two gates stand between `node build.mjs` and the force-push, and they are
# HERE rather than in whatever calls this script, so that the hand-run and the
# pr-merge-poller's automated run cannot diverge. One publish implementation,
# one place the checks live, nothing to bypass:
#
#   1. test-triage.py runs `node test.mjs` and decides whether its failures
#      matter. The live-API section pins the state of specific upstream PRs and
#      goes stale when they merge and ship; three of its cases are stale today.
#      A bare `node test.mjs` under `set -e` therefore aborted this script
#      before it built anything. The triage re-checks each stale case's cause
#      against GitHub and lets ONLY genuinely expired fixtures through.
#      Anything else -- a new failure, a missing privacy test, a short run --
#      stops the publish.
#
#   2. redaction-scan.py reads dist/index.html, the actual bytes about to be
#      pushed, and refuses on any reference to a private repo. The page has
#      leaked private repo names twice; build.mjs's redactPrivate() and the
#      suite both check the CODE, and this checks the OUTPUT, deliberately by a
#      different mechanism.
#
# Both fail closed: if the guard scripts are missing, or GitHub cannot be
# reached to run the checks, this script exits non-zero and publishes nothing.
# "I could not check" is not "it is clean".
#
# NOTE FOR A CI RUNNER: PMP_DIR below is a path on the box this dashboard is
# operated from. .github/build.yml (still parked, not installed) does not call
# this script -- it runs test.mjs and build.mjs itself -- so activating that
# workflow does not require these guards on the runner. If it is ever pointed
# at this script, port the two guards with it.
set -euo pipefail
cd "$(dirname "$0")"
root=$(pwd)
export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"

# The single switch that turns the leak on. Set explicitly rather than
# inherited: a stray INCLUDE_PRIVATE=true left in a shell or a unit file is
# exactly how the public page ends up naming private repos.
export INCLUDE_PRIVATE=false

PMP_DIR="${PMP_DIR:-/root/pr-merge-poller}"

"$PMP_DIR/test-triage.py"
node build.mjs
"$PMP_DIR/redaction-scan.py" dist/index.html

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
