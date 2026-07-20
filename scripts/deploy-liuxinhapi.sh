#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@liuxinhapi.1to10.cn}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/hapi-liuxin-src}"
REMOTE_PM2_APP="${REMOTE_PM2_APP:-hapi-hub-liuxin}"
REMOTE_BUN="${REMOTE_BUN:-/home/ubuntu/.bun/bin/bun}"
PUBLIC_URL="${PUBLIC_URL:-https://liuxinhapi.1to10.cn}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu}"
SSH_OPTS="${SSH_OPTS:-}"
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-20}"
SMOKE_DELAY_SECONDS="${SMOKE_DELAY_SECONDS:-3}"
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
  --skip-build    Skip local Web build/upload and remote Hub build
  --skip-restart  Skip PM2 restart
  -h, --help      Show this help

Environment overrides:
  REMOTE_HOST=$REMOTE_HOST
  REMOTE_DIR=$REMOTE_DIR
  REMOTE_PM2_APP=$REMOTE_PM2_APP
  REMOTE_BUN=$REMOTE_BUN
  PUBLIC_URL=$PUBLIC_URL
  SSH_OPTS="$SSH_OPTS"
  SMOKE_ATTEMPTS=$SMOKE_ATTEMPTS
  SMOKE_DELAY_SECONDS=$SMOKE_DELAY_SECONDS

What it does:
  1. Optional local tests/typecheck
  2. Build Web locally and calculate a deterministic artifact digest
  3. Back up the remote source and runtime build artifacts
  4. rsync source plus the verified local Web artifact
  5. Frozen remote install + embedded assets + Hub build
  6. PM2 restart + retrying smoke checks, with runtime rollback on failure
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
require_cmd shasum

[[ "$SMOKE_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "SMOKE_ATTEMPTS must be a positive integer"
[[ "$SMOKE_DELAY_SECONDS" =~ ^[0-9]+$ ]] || fail "SMOKE_DELAY_SECONDS must be a non-negative integer"

web_dist_digest() {
    local dist_dir="$1"

    (
        cd "$dist_dir"
        find . -type f | LC_ALL=C sort | while IFS= read -r file; do
            shasum -a 256 "$file"
        done
    ) | shasum -a 256 | awk '{print $1}'
}

smoke_check() {
    local attempt health root_html service_worker

    for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
        health="$(curl -k -fsS "$PUBLIC_URL/health" 2>/dev/null)" || health=""
        root_html="$(curl -k -fsS "$PUBLIC_URL" 2>/dev/null)" || root_html=""
        service_worker="$(curl -k -fsS "$PUBLIC_URL/sw.js" 2>/dev/null)" || service_worker=""

        if [[ "$health" == *'"status":"ok"'* ]] \
            && [[ "$root_html" == *'id="root"'* ]] \
            && [[ "$service_worker" == *'visibilityState'* ]]; then
            log "Smoke check passed on attempt $attempt"
            return 0
        fi

        warn "Smoke check attempt $attempt/$SMOKE_ATTEMPTS failed"
        if ((attempt < SMOKE_ATTEMPTS)); then
            sleep "$SMOKE_DELAY_SECONDS"
        fi
    done

    return 1
}

restore_runtime() {
    remote "set -e; cd '$REMOTE_PARENT'; test -f '$BACKUP_PATH'; tar -tzf '$BACKUP_PATH' | grep -q '^$REMOTE_BASE/web/dist/'; tar -tzf '$BACKUP_PATH' | grep -q '^$REMOTE_BASE/hub/dist/'; rm -rf '$REMOTE_BASE/web/dist' '$REMOTE_BASE/hub/dist'; tar -xzf '$BACKUP_PATH' '$REMOTE_BASE/web/dist' '$REMOTE_BASE/hub/dist'; pm2 restart '$REMOTE_PM2_APP' --update-env; pm2 save"
}

log "Target: $REMOTE_HOST:$REMOTE_DIR ($REMOTE_PM2_APP)"

if [[ "$SKIP_TESTS" != "1" ]]; then
    log "Running local focused tests"
    run bun test \
        hub/src/sync/sessionModel.test.ts \
        hub/src/socket/handlers/cli/sessionHandlers.test.ts \
        hub/src/sse/sseManager.test.ts \
        hub/src/notifications/notificationHub.test.ts

    log "Running local typecheck"
    run bun typecheck
else
    warn "Skipping local tests/typecheck"
fi

TS="$(date +%Y%m%d%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/hapi-liuxin-src-backup-$TS.tar.gz"
REMOTE_PARENT="$(dirname "$REMOTE_DIR")"
REMOTE_BASE="$(basename "$REMOTE_DIR")"
LOCAL_WEB_DIGEST=""

if [[ "$SKIP_BUILD" != "1" ]]; then
    log "Building Web locally"
    run bun run build:web

    if [[ "$DRY_RUN" != "1" ]]; then
        [[ -f web/dist/index.html ]] || fail "Local Web build did not produce web/dist/index.html"
        LOCAL_WEB_DIGEST="$(web_dist_digest web/dist)"
        log "Local Web artifact digest: $LOCAL_WEB_DIGEST"
    fi
else
    warn "Skipping local Web build/upload and remote Hub build"
fi

log "Creating remote backup: $BACKUP_PATH"
remote "set -e; if [ -d '$REMOTE_DIR' ]; then cd '$REMOTE_PARENT'; tar -czf '$BACKUP_PATH' --exclude='*/node_modules' --exclude='$REMOTE_BASE/cli/dist-exe' --exclude='$REMOTE_BASE/website/dist' --exclude='$REMOTE_BASE/docs/.vitepress/dist' '$REMOTE_BASE'; else echo 'remote dir missing, no backup'; fi"

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
    --exclude='.learnings/'
    --exclude='CLAUDE.local.md'
    --exclude='.DS_Store'
)
if [[ -n "$SSH_OPTS" ]]; then
    RSYNC_ARGS+=(-e "ssh $SSH_OPTS")
fi
if [[ "$DRY_RUN" == "1" ]]; then
    RSYNC_ARGS+=(--dry-run)
fi
run rsync "${RSYNC_ARGS[@]}" ./ "$REMOTE_HOST:$REMOTE_DIR/"

if [[ "$SKIP_INSTALL" != "1" ]]; then
    log "Installing locked dependencies on remote"
    remote "set -e; export PATH=\"$(dirname "$REMOTE_BUN"):\$PATH\"; cd '$REMOTE_DIR'; if [ -d node_modules/.bun ] || [ -d web/node_modules/.bun ] || [ -d hub/node_modules/.bun ] || [ -d cli/node_modules/.bun ]; then echo 'mixed Bun dependency layout detected; reinstalling all workspaces cleanly'; rm -rf node_modules web/node_modules hub/node_modules cli/node_modules shared/node_modules website/node_modules docs/node_modules; fi; '$REMOTE_BUN' install --frozen-lockfile"
else
    warn "Skipping remote bun install"
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
    log "Uploading locally built Web artifact"
    WEB_RSYNC_ARGS=(-az --delete --checksum)
    if [[ -n "$SSH_OPTS" ]]; then
        WEB_RSYNC_ARGS+=(-e "ssh $SSH_OPTS")
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        WEB_RSYNC_ARGS+=(--dry-run)
    fi
    run rsync "${WEB_RSYNC_ARGS[@]}" web/dist/ "$REMOTE_HOST:$REMOTE_DIR/web/dist/"

    if [[ "$DRY_RUN" == "1" ]]; then
        log "Would verify local and remote Web artifact digests"
    else
        REMOTE_WEB_DIGEST="$(remote "set -e; cd '$REMOTE_DIR/web/dist'; (find . -type f | LC_ALL=C sort | while IFS= read -r file; do sha256sum \"\$file\"; done) | sha256sum | awk '{print \$1}'")"
        [[ "$REMOTE_WEB_DIGEST" == "$LOCAL_WEB_DIGEST" ]] \
            || fail "Web artifact digest mismatch: local=$LOCAL_WEB_DIGEST remote=$REMOTE_WEB_DIGEST"
        log "Remote Web artifact digest verified"
    fi

    log "Embedding uploaded Web assets and building Hub on remote"
    remote "set -e; export PATH=\"$(dirname "$REMOTE_BUN"):\$PATH\"; cd '$REMOTE_DIR'; '$REMOTE_BUN' run --cwd hub generate:embedded-web-assets; '$REMOTE_BUN' run build:hub"
fi

if [[ "$SKIP_RESTART" != "1" ]]; then
    log "Restarting PM2 app: $REMOTE_PM2_APP"
    if ! remote "set -e; pm2 restart '$REMOTE_PM2_APP' --update-env; pm2 save; pm2 pid '$REMOTE_PM2_APP'"; then
        warn "PM2 restart failed; restoring previous runtime artifacts"
        if restore_runtime; then
            fail "PM2 restart failed; previous runtime artifacts were restored"
        fi
        fail "PM2 restart failed and runtime rollback could not be completed"
    fi
else
    warn "Skipping PM2 restart"
fi

if [[ "$DRY_RUN" == "1" ]]; then
    log "Skipping smoke check in dry-run mode"
else
    log "Smoke check: $PUBLIC_URL"
    if ! smoke_check; then
        warn "Deployment smoke check failed; restoring previous runtime artifacts"
        if restore_runtime; then
            if smoke_check; then
                fail "Deployment failed its smoke check; previous runtime artifacts were restored"
            fi
            fail "Deployment and rollback smoke checks both failed"
        fi
        fail "Deployment smoke check failed and runtime rollback could not be completed"
    fi
fi

log "Done. Backup: $BACKUP_PATH"
log "If testing on phone: close/reopen PWA once so the new service worker activates."
