#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: deploy-rich.sh

Deploy the smena service from this checkout. Run after updating the rich
checkout. Docker and compose paths can be overridden with:
  SMENA_DEPLOY_DOCKER, SMENA_DEPLOY_SUDO, SMENA_DEPLOY_COMPOSE_FILE,
  SMENA_DEPLOY_ROOT, SMENA_DEPLOY_HEALTH_TIMEOUT, SMENA_DEPLOY_POLL_INTERVAL,
  SMENA_DEPLOY_GATEWAY
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi
if [ "$#" -ne 0 ]; then usage >&2; exit 2; fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${SMENA_DEPLOY_ROOT:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}
COMPOSE_FILE=${SMENA_DEPLOY_COMPOSE_FILE:-/volume1/security/docker/app-docker-container/docker-compose.yml}
DOCKER=${SMENA_DEPLOY_DOCKER:-/usr/local/bin/docker}
SUDO=${SMENA_DEPLOY_SUDO-sudo}
HEALTH_TIMEOUT=${SMENA_DEPLOY_HEALTH_TIMEOUT:-180}
POLL_INTERVAL=${SMENA_DEPLOY_POLL_INTERVAL:-2}
STATE=$ROOT/.deploy-version
LOCK=$ROOT/.deploy-rich.lock

fail() { printf 'deploy-rich: %s\n' "$*" >&2; exit 1; }
run_docker() {
  if [ -n "$SUDO" ]; then "$SUDO" "$DOCKER" "$@"; else "$DOCKER" "$@"; fi
}
compose() { run_docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE" "$@"; }
valid_version() { printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }
version_gt() {
  awk -F. -v a="$1" -v b="$2" 'BEGIN {
    split(a,x,"."); split(b,y,".");
    for(i=1;i<=3;i++){ if((x[i]+0)>(y[i]+0)) exit 0; if((x[i]+0)<(y[i]+0)) exit 1 }
    exit 1
  }'
}
max_version() { if version_gt "$1" "$2"; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

[ -f "$COMPOSE_FILE" ] || fail "compose file not found: $COMPOSE_FILE"
[ -f "$ROOT/package.json" ] || fail "package.json not found in $ROOT"
BASE_VERSION=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$ROOT/package.json" | sed -n '1p')
valid_version "$BASE_VERSION" || fail 'package.json must contain a numeric semantic version'

if ! mkdir "$LOCK" 2>/dev/null; then fail "another deployment is running (lock: $LOCK)"; fi
TMP_DIR=
cleanup() { [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"; rm -f "${STATE_TMP:-}"; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/smena-deploy.XXXXXX")
OVERRIDE=$TMP_DIR/compose.override.yml

# Include the currently deployed image in the high-water mark, so removing the
# counter file cannot accidentally roll the version backwards.
CURRENT_VERSION=
CURRENT_CID=$(run_docker compose -f "$COMPOSE_FILE" ps -q smena) || fail 'cannot inspect the current smena container'
if [ -n "$CURRENT_CID" ]; then
  CURRENT_VERSION=$(run_docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$CURRENT_CID") || fail 'cannot read the current image version'
  if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" != '<no value>' ] && [ "$CURRENT_VERSION" != 'unknown' ]; then
    valid_version "$CURRENT_VERSION" || fail "current container has an invalid version label: $CURRENT_VERSION"
  else
    CURRENT_VERSION=
  fi
fi

VERSION=$BASE_VERSION
if [ -f "$STATE" ]; then
  STORED_VERSION=$(cat "$STATE")
  valid_version "$STORED_VERSION" || fail "invalid version counter in $STATE"
  VERSION=$(max_version "$VERSION" "$STORED_VERSION")
fi
if [ -n "$CURRENT_VERSION" ]; then VERSION=$(max_version "$VERSION" "$CURRENT_VERSION"); fi
VERSION=$(awk -F. '{ printf "%d.%d.%d\n", $1, $2, $3+1 }' <<EOF
$VERSION
EOF
)
REVISION=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)

cat >"$OVERRIDE" <<EOF
services:
  smena:
    build:
      args:
        APP_VERSION: "$VERSION"
        VCS_REF: "$REVISION"
EOF

compose config -q || fail 'compose configuration validation failed'
printf 'Building smena %s\n' "$VERSION"
compose build smena || fail 'smena image build failed'
compose up -d --no-deps --no-build smena || fail 'smena container start failed'

START=$(date +%s)
while :; do
  CID=$(compose ps -q smena) || fail 'cannot inspect the deployed smena container'
  [ -n "$CID" ] || fail 'deployed smena container was not found'
  STATUS=$(run_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CID") || fail 'cannot read smena health status'
  case "$STATUS" in
    healthy) break ;;
    unhealthy|missing) fail "smena did not become healthy (status: $STATUS)" ;;
    starting) ;;
    *) fail "unexpected smena health status: $STATUS" ;;
  esac
  NOW=$(date +%s)
  [ $((NOW - START)) -lt "$HEALTH_TIMEOUT" ] || fail "smena health check timed out after ${HEALTH_TIMEOUT}s"
  sleep "$POLL_INTERVAL"
done

DEPLOYED_VERSION=$(run_docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$CID") || fail 'cannot read deployed image version'
[ "$DEPLOYED_VERSION" = "$VERSION" ] || fail "deployed image version mismatch (expected $VERSION, got $DEPLOYED_VERSION)"

GATEWAY=${SMENA_DEPLOY_GATEWAY:-app-gateway}
run_docker exec "$GATEWAY" nginx -t || fail 'nginx configuration validation failed'
run_docker exec "$GATEWAY" nginx -s reload || fail 'nginx reload failed'

STATE_TMP=$LOCK/version
printf '%s\n' "$VERSION" >"$STATE_TMP"
mv "$STATE_TMP" "$STATE"
printf 'Deployed smena %s successfully\n' "$VERSION"
