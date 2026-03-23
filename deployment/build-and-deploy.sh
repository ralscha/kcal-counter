#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kcal-counter}"
BUILD_DIR="${BUILD_DIR:-$APP_ROOT/build}"
REPO_URL="${REPO_URL:-git@github.com:ralscha/kcal-counter.git}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-kcal-counter.service}"
APP_USER="${APP_USER:-kcal-counter}"
APP_GROUP="${APP_GROUP:-kcal-counter}"

BACKEND_LIVE_DIR="$APP_ROOT/backend"
BACKEND_BIN_DIR="$BACKEND_LIVE_DIR/bin"
BACKEND_CONFIG_DIR="$BACKEND_LIVE_DIR/config"
FRONTEND_LIVE_DIR="$APP_ROOT/frontend"
FRONTEND_DIST_DIR="$FRONTEND_LIVE_DIR/dist"

BACKEND_BUILD_DIR="$BUILD_DIR/backend"
FRONTEND_BUILD_DIR="$BUILD_DIR/frontend"
BACKEND_BUILD_BINARY="$BACKEND_BUILD_DIR/bin/app"
FRONTEND_BUILD_DIST="$FRONTEND_BUILD_DIR/dist"

service_was_running=false

log() {
  printf '[deploy] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

ensure_root() {
  if [ "${EUID}" -ne 0 ]; then
    printf 'run this script as root\n' >&2
    exit 1
  fi
}

cleanup_build_dir() {
  rm -rf "$BUILD_DIR"
}

set_permissions() {
  local target=$1

  chown -R "$APP_USER:$APP_GROUP" "$target"
  find "$target" -type d -exec chmod 0755 {} +
  find "$target" -type f -exec chmod 0644 {} +
}

ensure_root

if [ -z "$REPO_URL" ]; then
  printf 'set REPO_URL before running this script\n' >&2
  exit 1
fi

for command_name in git go bun systemctl install find cp mv rm chown chmod; do
  require_command "$command_name"
done

trap cleanup_build_dir EXIT

log "cloning $REPO_URL#$BRANCH into $BUILD_DIR"
cleanup_build_dir
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$BUILD_DIR"

log "building backend"
mkdir -p "$BACKEND_BUILD_DIR/bin"
(
  cd "$BACKEND_BUILD_DIR"
  go build -o ./bin/app ./cmd/app
)

log "building frontend"
(
  cd "$FRONTEND_BUILD_DIR"
  bun install --frozen-lockfile
  bun run build
  bun run compress
)

if [ ! -x "$BACKEND_BUILD_BINARY" ]; then
  printf 'backend build did not produce %s\n' "$BACKEND_BUILD_BINARY" >&2
  exit 1
fi

if [ ! -d "$FRONTEND_BUILD_DIST" ]; then
  printf 'frontend build did not produce %s\n' "$FRONTEND_BUILD_DIST" >&2
  exit 1
fi

log "preparing live directories"
install -d -m 0755 "$APP_ROOT" "$BACKEND_BIN_DIR" "$BACKEND_CONFIG_DIR" "$FRONTEND_LIVE_DIR"

log "publishing frontend artefacts"
rm -rf "$FRONTEND_DIST_DIR.next"
cp -a "$FRONTEND_BUILD_DIST" "$FRONTEND_DIST_DIR.next"
set_permissions "$FRONTEND_DIST_DIR.next"
rm -rf "$FRONTEND_DIST_DIR.previous"
if [ -d "$FRONTEND_DIST_DIR" ]; then
  mv "$FRONTEND_DIST_DIR" "$FRONTEND_DIST_DIR.previous"
fi
mv "$FRONTEND_DIST_DIR.next" "$FRONTEND_DIST_DIR"
rm -rf "$FRONTEND_DIST_DIR.previous"

log "staging backend binary"
install -m 0755 "$BACKEND_BUILD_BINARY" "$BACKEND_BIN_DIR/app.next"
chown "$APP_USER:$APP_GROUP" "$BACKEND_BIN_DIR/app.next"
chmod 0755 "$BACKEND_BIN_DIR/app.next"

if systemctl is-active --quiet "$SERVICE_NAME"; then
  service_was_running=true
  log "stopping $SERVICE_NAME"
  systemctl stop "$SERVICE_NAME"
fi

log "publishing backend binary"
rm -f "$BACKEND_BIN_DIR/app.previous"
if [ -f "$BACKEND_BIN_DIR/app" ]; then
  mv "$BACKEND_BIN_DIR/app" "$BACKEND_BIN_DIR/app.previous"
fi
mv "$BACKEND_BIN_DIR/app.next" "$BACKEND_BIN_DIR/app"
chown "$APP_USER:$APP_GROUP" "$BACKEND_BIN_DIR/app"
chmod 0755 "$BACKEND_BIN_DIR/app"

log "starting $SERVICE_NAME"
systemctl start "$SERVICE_NAME"

log "cleaning up build directory"
cleanup_build_dir

if [ "$service_was_running" = true ]; then
  rm -f "$BACKEND_BIN_DIR/app.previous"
fi

log "deployment complete"