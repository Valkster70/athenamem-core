#!/usr/bin/env bash
set -euo pipefail

HERMES_HOST="${HERMES_HOST:-hermes}"
REPO_DIR="${REPO_DIR:-$HOME/projects/athenamem-core}"
LIVE_PLUGIN_DIR="${LIVE_PLUGIN_DIR:-/home/chris/.openclaw/plugins/athenamem}"

printf '\n==> Deploying AthenaMem to %s\n' "$HERMES_HOST"
ssh -F "$HOME/.ssh/config" "$HERMES_HOST" "mkdir -p '$LIVE_PLUGIN_DIR'"

printf '==> Syncing repo to live plugin dir\n'
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'coverage/' \
  --exclude '.DS_Store' \
  "$REPO_DIR/" "$HERMES_HOST:$LIVE_PLUGIN_DIR/"

printf '==> Building, testing, restarting gateway on Hermes\n'
ssh -F "$HOME/.ssh/config" "$HERMES_HOST" "
  set -euo pipefail
  cd '$LIVE_PLUGIN_DIR'
  if [ ! -d node_modules ]; then
    npm install >/tmp/athenamem-deploy-npm.log 2>&1
  fi
  npm run build >/tmp/athenamem-deploy-build.log 2>&1
  npm test >/tmp/athenamem-deploy-test.log 2>&1
  openclaw gateway restart >/tmp/athenamem-deploy-restart.log 2>&1
  printf 'PACKAGE_VERSION '
  node -e \"const p=require('./package.json'); console.log(p.version)\"
  printf '\nTEST_SUMMARY\n'
  tail -8 /tmp/athenamem-deploy-test.log
"

printf '\n==> Deploy complete\n'
