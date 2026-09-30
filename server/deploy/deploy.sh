#!/usr/bin/env bash
# Deploys the leaderboard API to the droplet from a checkout of this repo. Repeatable: every run uploads a release
# named after the commit, installs its dependencies, flips /opt/minesweeper-api/current, (re)installs the systemd
# units and the nginx snippet, restarts and health-checks; the previous release is restored if the check fails.
#
#     server/deploy/deploy.sh                    # HOST=root@134.209.83.197 SSH_KEY=~/.ssh/id_ed25519 by default
set -euo pipefail
HOST=${HOST:-root@134.209.83.197}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
SSH="ssh -o BatchMode=yes -i $SSH_KEY"
cd "$(dirname "$0")/../.."
REL=$(git rev-parse --short HEAD)
git diff --quiet HEAD -- server minesweeper/engine.js minesweeper/names.js || REL="$REL-dirty-$(date +%s)"
DEST=/opt/minesweeper-api/releases/$REL
echo "deploying $REL to $HOST"
$SSH "$HOST" "mkdir -p $DEST/server $DEST/minesweeper"
# The server imports the game's own engine and name rules from ../../minesweeper/, so keep that layout.
rsync -a --delete -e "$SSH" --exclude node_modules --exclude test server/ "$HOST:$DEST/server/"
rsync -a -e "$SSH" minesweeper/engine.js minesweeper/names.js "$HOST:$DEST/minesweeper/"
$SSH "$HOST" "bash -s -- $REL" < server/deploy/remote.sh
