#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@liuxinhapi.1to10.cn}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/hapi-liuxin-src}"
REMOTE_PM2_APP="${REMOTE_PM2_APP:-hapi-hub-liuxin}"
REMOTE_BUN="${REMOTE_BUN:-/home/ubuntu/.bun/bin/bun}"
PUBLIC_URL="${PUBLIC_URL:-https://liuxinhapi.1to10.cn}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu}"
SSH_OPTS="${SSH_OPTS:-}"
DRY_RUN=0
SKIP_INSTALL=0
SKIP_TESTS=0
SKIP_BUILD=0
SKIP_RESTART=0

usage() {
    cat <<USAGE
Deploy local working tree to liuxinhapi hub.

Usage:
  scripts/deploy-liuxinhapi.sh [options]

Options:
  --dry-run       Show rsync/build/restart commands without changing remote files
  --skip-install  Skip remote bun install
  --skip-tests    Skip local focused tests/typecheck
  --skip-build    Skip remote web/hub build
  --skip-restart  Skip PM2 restart
  -h, --help      Show this help

Environment overrides:
  REMOTE_HOST=$REMOTE_HOST
  REMOTE_DIR=$REMOTE_DIR
  REMOTE_PM2_APP=$REMOTE_PM2_APP
  REMOTE_BUN=$REMOTE_BUN
  PUBLIC_URL=$PUBLIC_URL
  SSH_OPTS="$SSH_OPTS"

What it does:
  1. Optional local tests/typecheck
  2. Remote backup of source dir, excluding heavy build/dependency dirs
  3. rsync local repo to remote source dir
  4. Remote bun install + build:web + embedded assets + build:hub
  5. PM2 restart + smoke checks
USAGE
}

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy:warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy:error]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --skip-install) SKIP_INSTALL=1 ;;
        --skip-tests) SKIP_TESTS=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        --skip-restart) SKIP_RESTART=1 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
    shift
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

run() {
    if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ '
        printf '%q ' "$@"
        printf '\n'
        return 0
    fi
    "$@"
}

remote() {
    # shellcheck disable=SC2086
    run ssh $SSH_OPTS "$REMOTE_HOST" "$@"
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

require_cmd ssh
require_cmd rsync
require_cmd bun
require_cmd curl

log "Target: $REMOTE_HOST:$REMOTE_DIR ($REMOTE_PM2_APP)"

if [[ "$SKIP_TESTS" != "1" ]]; then
    log "Running local focused tests"
    run bun test \
        hub/src/sync/sessionModel.test.ts \
        hub/src/socket/handlers/cli/sessionHandlers.test.ts \
        cli/src/codex/codexLocal.test.ts \
        cli/src/codex/utils/codexSessionScanner.test.ts \
        hub/src/sse/sseManager.test.ts \
        hub/src/notifications/notificationHub.test.ts

    log "Running local typecheck"
    run bun typecheck
else
    warn "Skipping local tests/typecheck"
fi

TS="$(date +%Y%m%d%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/hapi-liuxin-src-backup-$TS.tar.gz"

log "Creating remote backup: $BACKUP_PATH"
remote "set -e; if [ -d '$REMOTE_DIR' ]; then cd \"$(dirname "$REMOTE_DIR")\"; tar -czf '$BACKUP_PATH' --exclude='$(basename "$REMOTE_DIR")/node_modules' --exclude='$(basename "$REMOTE_DIR")/web/dist' --exclude='$(basename "$REMOTE_DIR")/hub/dist' '$(basename "$REMOTE_DIR")'; else echo 'remote dir missing, no backup'; fi"

log "Syncing source"
RSYNC_ARGS=(
    -az --delete
    --exclude='.git/'
    --exclude='node_modules/'
    --exclude='cli/dist-exe/'
    --exclude='hub/dist/'
    --exclude='web/dist/'
    --exclude='website/dist/'
    --exclude='docs/.vitepress/dist/'
    --exclude='.DS_Store'
)
if [[ "$DRY_RUN" == "1" ]]; then
    RSYNC_ARGS+=(--dry-run)
fi
run rsync "${RSYNC_ARGS[@]}" ./ "$REMOTE_HOST:$REMOTE_DIR/"

if [[ "$SKIP_INSTALL" != "1" ]]; then
    log "Installing dependencies on remote"
    remote "set -e; export PATH=\"$(dirname "$REMOTE_BUN"):\$PATH\"; cd '$REMOTE_DIR'; '$REMOTE_BUN' install"
else
    warn "Skipping remote bun install"
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
    log "Building web + hub on remote"
    remote "set -e; export PATH=\"$(dirname "$REMOTE_BUN"):\$PATH\"; cd '$REMOTE_DIR'; '$REMOTE_BUN' run build:web; '$REMOTE_BUN' run --cwd hub generate:embedded-web-assets; '$REMOTE_BUN' run build:hub"
else
    warn "Skipping remote build"
fi

if [[ "$SKIP_RESTART" != "1" ]]; then
    log "Restarting PM2 app: $REMOTE_PM2_APP"
    remote "set -e; pm2 restart '$REMOTE_PM2_APP' --update-env; pm2 save; sleep 2; pm2 pid '$REMOTE_PM2_APP'; pm2 status '$REMOTE_PM2_APP' --no-color"
else
    warn "Skipping PM2 restart"
fi

if [[ "$DRY_RUN" == "1" ]]; then
    log "Skipping smoke check in dry-run mode"
else
    log "Smoke check: $PUBLIC_URL"
    curl -k -fsSI "$PUBLIC_URL" >/dev/null
    curl -k -fsS "$PUBLIC_URL/sw.js" | grep -q 'visibilityState'
fi

log "Done. Backup: $BACKUP_PATH"
log "If testing on phone: close/reopen PWA once so the new service worker activates."
