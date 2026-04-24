#!/usr/bin/env bash
#
# deploy.sh — build the plugin and copy dist/ + metadata into the OpenClaw
# extensions directory, then restart the gateway so changes take effect.
#
# Usage:
#   ./scripts/deploy.sh            # build + deploy + restart
#   ./scripts/deploy.sh --no-build # deploy current dist/ without rebuilding
#   ./scripts/deploy.sh --no-restart  # build + deploy, don't restart gateway
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${OPENCLAW_WEBEX_TARGET:-$HOME/.openclaw/extensions/webex}"

DO_BUILD=1
DO_RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO_DIR"

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> Building…"
  npm run build
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "target directory not found: $TARGET_DIR" >&2
  echo "set OPENCLAW_WEBEX_TARGET to override." >&2
  exit 1
fi

echo "==> Deploying dist/ -> $TARGET_DIR/dist/"
# --delete so stale compiled files go away; keep node_modules intact.
rsync -a --delete ./dist/ "$TARGET_DIR/dist/"

echo "==> Syncing metadata (package.json, openclaw.plugin.json)"
cp -f package.json "$TARGET_DIR/package.json"
cp -f openclaw.plugin.json "$TARGET_DIR/openclaw.plugin.json"

if [[ "$DO_RESTART" -eq 1 ]]; then
  echo "==> Restarting openclaw-gateway…"
  systemctl --user restart openclaw-gateway.service
  sleep 3
  if systemctl --user is-active --quiet openclaw-gateway.service; then
    echo "    gateway is active"
  else
    echo "    gateway is NOT active — check 'journalctl --user -u openclaw-gateway -n 50'" >&2
    exit 1
  fi
fi

echo "==> Done."
