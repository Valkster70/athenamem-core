#!/usr/bin/env bash
set -euo pipefail

HERMES_HOST="${HERMES_HOST:-hermes}"
REPO_DIR="${REPO_DIR:-$HOME/projects/athenamem-core}"
LIVE_EXTENSION_DIR="${LIVE_EXTENSION_DIR:-/home/chris/.openclaw/extensions/athenamem-core}"

printf '\n==> Deploying AthenaMem to %s\n' "$HERMES_HOST"
ssh -F "$HOME/.ssh/config" "$HERMES_HOST" "mkdir -p '$LIVE_EXTENSION_DIR'"

printf '==> Syncing repo to active extension dir\n'
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'coverage/' \
  --exclude '.DS_Store' \
  "$REPO_DIR/" "$HERMES_HOST:$LIVE_EXTENSION_DIR/"

printf '==> Building, testing, restarting gateway on Hermes\n'
ssh -F "$HOME/.ssh/config" "$HERMES_HOST" "
  set -euo pipefail
  cd '$LIVE_EXTENSION_DIR'
  if [ ! -d node_modules ]; then
    npm install >/tmp/athenamem-deploy-npm.log 2>&1
  fi
  npm run build >/tmp/athenamem-deploy-build.log 2>&1
  npm test >/tmp/athenamem-deploy-test.log 2>&1
  openclaw gateway restart >/tmp/athenamem-deploy-restart.log 2>&1
  printf 'PACKAGE_VERSION '
  node -e \"const p=require('./package.json'); console.log(p.version)\"
  printf '\nACTIVE_TOOL_CHECK\n'
  grep -n 'athenamem_core_wal_flush' dist/index.js | head -1
  printf '\nTEST_SUMMARY\n'
  tail -8 /tmp/athenamem-deploy-test.log
"

printf '\n==> Deploy complete\n'
