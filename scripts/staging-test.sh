#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Staging Test — Runs on the production server (isolated)
# ============================================================================
# SSHs to the server, builds the image from HEAD, runs install.sh in a
# temporary HOME on an unused port, verifies the full user flow, then
# cleans everything up. Production is never touched.
#
# Isolation:
#   - Temp HOME (/tmp/fairtrail-staging-*) — no files touch ~
#   - Unique Docker project name (fairtrail-staging-test)
#   - Unique port (3098) — prod uses 3003
#   - Unique volume prefix — no shared state with prod
#   - Lock file — prevents concurrent staging runs
#   - Trap cleanup — removes everything on exit/failure
#
# Tests what no local Docker test can:
#   1. Real Docker socket permissions on Linux
#   2. Real systemd/Docker daemon interaction
#   3. Real network (image pull, Chromium download)
#   4. Real SSH login shell PATH
#   5. Real .env generation and container startup
#   6. Real health check against live DB + Redis
#   7. Real curl against flight-finder.org (artifact freshness)
#   8. Real CLI commands (status, version)
#
# Usage:
#   bash scripts/staging-test.sh           # Build + test
#   bash scripts/staging-test.sh --quick   # Skip image build (reuse existing)
#
# Secrets (env vars or GitHub Actions secrets):
#   STAGING_HOST  — SSH config alias (default: fairtrail-prod)
#   REPO_TOKEN    — GitHub PAT for cloning (fallback: Doppler)
# ============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

STAGING_PORT="${STAGING_PORT:-3097}"
STAGING_PROJECT="fairtrail-staging-test"
STAGING_HOST="${STAGING_HOST:-fairtrail-prod}"
QUICK=false
[[ "${1:-}" == "--quick" ]] && QUICK=true

echo ""
printf "${BOLD}Fairtrail staging test${RESET}\n"
printf "${DIM}Target: ${STAGING_HOST}:${STAGING_PORT}${RESET}\n"
echo ""

# Secrets from env (GitHub Actions) or Doppler (local)
if [ -z "${REPO_TOKEN:-}" ]; then
  REPO_TOKEN=$(doppler secrets get REPO_TOKEN --plain --project flight-finder --config prd 2>/dev/null || echo "")
fi
if [ -z "${REPO_TOKEN:-}" ]; then
  printf "${RED}REPO_TOKEN not set. Set via env or Doppler.${RESET}\n"
  exit 1
fi

LOCAL_SHA=$(git rev-parse --short HEAD)
LOCAL_MSG=$(git log -1 --format='%s')
printf "${DIM}Commit: ${LOCAL_SHA} ${LOCAL_MSG}${RESET}\n"
echo ""

BRANCH=$(git branch --show-current)

# Build SSH command
SSH_CMD="ssh"
if [ -n "${STAGING_SSH_KEY:-}" ]; then
  SSH_CMD="ssh -i $STAGING_SSH_KEY -o StrictHostKeyChecking=no"
fi

$SSH_CMD "$STAGING_HOST" "REPO_TOKEN='$REPO_TOKEN' BRANCH='$BRANCH' STAGING_PORT='$STAGING_PORT' PROJECT='$STAGING_PROJECT' QUICK='$QUICK' bash -s" << 'ENDSSH'
set -euo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $*"; }

# --- Find a free port (starting from requested, decrement until free) ---
while ss -tlnp 2>/dev/null | grep -q ":${STAGING_PORT} "; do
  echo "  Port $STAGING_PORT in use, trying $((STAGING_PORT - 1))"
  STAGING_PORT=$((STAGING_PORT - 1))
  if [ "$STAGING_PORT" -lt 3050 ]; then
    echo "  FATAL: No free port found in 3050-3097 range"
    exit 1
  fi
done
echo "  Using port $STAGING_PORT"

# --- Lock file to prevent concurrent staging runs ---
LOCKFILE="/tmp/fairtrail-staging.lock"
if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "  FATAL: Another staging test is running (PID $LOCK_PID)"
    exit 1
  fi
  echo "  Removing stale lock file"
  rm -f "$LOCKFILE"
fi
echo "$$" > "$LOCKFILE"

TEST_HOME=""
REPO_DIR=""

cleanup() {
  echo ""
  echo "  Cleaning up staging..."
  # Stop staging containers
  if [ -n "$TEST_HOME" ] && [ -d "$TEST_HOME/.flight-finder" ]; then
    cd "$TEST_HOME/.flight-finder"
    docker compose -p "$PROJECT" down -v 2>/dev/null || true
  fi
  # Remove temp HOME and repo clone
  [ -n "$TEST_HOME" ] && rm -rf "$TEST_HOME"
  [ -n "$REPO_DIR" ] && rm -rf "$REPO_DIR"
  # Remove staging image (save disk)
  docker rmi fairtrail-staging:latest 2>/dev/null || true
  # Release lock
  rm -f "$LOCKFILE"
  echo "  Done."
}
trap cleanup EXIT

# --- Clone the branch ---
REPO_DIR=$(mktemp -d /tmp/fairtrail-repo-XXXXXX)
git clone --depth 1 --branch "$BRANCH" \
  "https://x-access-token:${REPO_TOKEN}@github.com/affromero/flight-finder.git" \
  "$REPO_DIR" 2>&1 | tail -1
echo "  Checked out $BRANCH"

# === Test 0: Artifact freshness (non-fatal -- deploy may be pending) ===
echo ""
echo "  === Artifact freshness ==="
PROD_INSTALL=$(curl -sf https://flight-finder.org/install.sh 2>/dev/null | md5sum | cut -d' ' -f1 || echo "unreachable")
LOCAL_INSTALL=$(md5sum < "$REPO_DIR/apps/web/public/install.sh" | cut -d' ' -f1)
if [ "$PROD_INSTALL" = "unreachable" ]; then
  echo "  SKIP flight-finder.org unreachable (not fatal)"
elif [ "$PROD_INSTALL" = "$LOCAL_INSTALL" ]; then
  pass "flight-finder.org/install.sh matches HEAD"
else
  echo "  WARN flight-finder.org/install.sh differs from HEAD (deploy needed after merge)"
fi

PROD_CLI=$(curl -sf https://flight-finder.org/flight-finder-cli 2>/dev/null | md5sum | cut -d' ' -f1 || echo "unreachable")
LOCAL_CLI=$(md5sum < "$REPO_DIR/apps/web/public/flight-finder-cli" | cut -d' ' -f1)
if [ "$PROD_CLI" = "unreachable" ]; then
  echo "  SKIP flight-finder.org unreachable (not fatal)"
elif [ "$PROD_CLI" = "$LOCAL_CLI" ]; then
  pass "flight-finder.org/flight-finder-cli matches HEAD"
else
  echo "  WARN flight-finder.org/flight-finder-cli differs from HEAD (deploy needed after merge)"
fi

# === Test 1: Docker build ===
echo ""
echo "  === Docker build ==="
if [ "$QUICK" = "true" ]; then
  echo "  Skipping build (--quick), tagging existing image"
  docker tag ghcr.io/affromero/flight-finder:latest fairtrail-staging:latest 2>/dev/null || \
    docker build -t fairtrail-staging:latest "$REPO_DIR" -q 2>&1 | tail -1
else
  docker build -t fairtrail-staging:latest "$REPO_DIR" -q 2>&1 | tail -1
fi
pass "Docker image built"

# === Test 2: Install flow ===
echo ""
echo "  === Install flow ==="
TEST_HOME=$(mktemp -d /tmp/fairtrail-staging-XXXXXX)
mkdir -p "$TEST_HOME/.local/bin"
echo "# default" > "$TEST_HOME/.bashrc"
echo "# default" > "$TEST_HOME/.profile"

env \
  HOME="$TEST_HOME" \
  FLIGHT_FINDER_YES=1 \
  FLIGHT_FINDER_REPO="$REPO_DIR" \
  FLIGHT_FINDER_CLI_SOURCE="$REPO_DIR/apps/web/public/flight-finder-cli" \
  FLIGHT_FINDER_SKIP_BUILD=1 \
  FLIGHT_FINDER_SKIP_START=1 \
  HOST_PORT="$STAGING_PORT" \
  bash "$REPO_DIR/apps/web/public/install.sh" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | while IFS= read -r line; do
    echo "    $line"
  done

[ -f "$TEST_HOME/.local/bin/flight-finder" ] && pass "CLI binary installed" || fail "CLI binary missing"
[ -f "$TEST_HOME/.flight-finder/docker-compose.yml" ] && pass "docker-compose.yml generated" || fail "docker-compose.yml missing"
[ -f "$TEST_HOME/.flight-finder/.env" ] && pass ".env generated" || fail ".env missing"
grep -qF '.local/bin' "$TEST_HOME/.bashrc" && pass "PATH in .bashrc" || fail "PATH not in .bashrc"
grep -qF '.local/bin' "$TEST_HOME/.profile" && pass "PATH in .profile (SSH fix)" || fail "PATH not in .profile"
grep -q 'HOST_PORT=' "$TEST_HOME/.flight-finder/.env" && pass ".env has HOST_PORT" || fail ".env missing HOST_PORT"

# === Test 3: Login shell ===
FOUND=$(HOME="$TEST_HOME" bash -l -c 'command -v fairtrail 2>/dev/null || echo "not-found"')
[ "$FOUND" != "not-found" ] && pass "Login shell finds fairtrail" || fail "Login shell cannot find fairtrail"

# === Test 4: App startup ===
echo ""
echo "  === App startup ==="

# The install.sh-generated compose hardcodes DB/Redis ports that may
# conflict with production. Write an override that removes host ports
# for DB/Redis (only the web port needs to be reachable from localhost).
cat > "$TEST_HOME/.flight-finder/docker-compose.override.yml" << OVERRIDE
services:
  db:
    ports: !override []
  redis:
    ports: !override []
  web:
    ports: !override
      - "127.0.0.1:${STAGING_PORT}:3003"
OVERRIDE

cd "$TEST_HOME/.flight-finder"
docker compose -p "$PROJECT" up -d 2>&1 | tail -5

RETRIES=120
until curl -sf "http://localhost:${STAGING_PORT}/api/health" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    fail "App not healthy after 120s"
    docker compose -p "$PROJECT" logs web --tail 20 2>&1 | tail -10
    break
  fi
  sleep 1
done

if [ "$RETRIES" -gt 0 ]; then
  pass "App healthy"

  # === Test 5: API checks ===
  echo ""
  echo "  === API checks ==="
  HEALTH=$(curl -sf "http://localhost:${STAGING_PORT}/api/health")
  echo "$HEALTH" | grep -q '"database":"connected"' && pass "DB connected" || fail "DB not connected"
  echo "$HEALTH" | grep -q '"redis":"connected"' && pass "Redis connected" || fail "Redis not connected"

  STATUS=$(curl -so /dev/null -w "%{http_code}" "http://localhost:${STAGING_PORT}/")
  [ "$STATUS" = "200" ] && pass "GET / returns 200" || fail "GET / returns $STATUS"

  STATUS=$(curl -so /dev/null -w "%{http_code}" "http://localhost:${STAGING_PORT}/settings")
  [ "$STATUS" = "200" ] && pass "GET /settings returns 200" || fail "GET /settings returns $STATUS"

  CONFIG=$(curl -sf "http://localhost:${STAGING_PORT}/api/admin/config")
  echo "$CONFIG" | grep -q '"defaultCurrency"' && pass "Config has defaultCurrency" || fail "Config missing defaultCurrency"
  echo "$CONFIG" | grep -q '"defaultCountry"' && pass "Config has defaultCountry" || fail "Config missing defaultCountry"

  PATCH=$(curl -sf "http://localhost:${STAGING_PORT}/api/admin/config" \
    -X PATCH -H 'Content-Type: application/json' \
    -d '{"defaultCurrency":"GBP","defaultCountry":"GB"}')
  echo "$PATCH" | grep -q '"ok":true' && pass "Config PATCH saves" || fail "Config PATCH failed"

  READBACK=$(curl -sf "http://localhost:${STAGING_PORT}/api/admin/config")
  echo "$READBACK" | grep -q '"defaultCurrency":"GBP"' && pass "Currency persisted (GBP)" || fail "Currency not persisted"

  PROVIDERS=$(curl -sf "http://localhost:${STAGING_PORT}/api/admin/providers")
  OLLAMA=$(echo "$PROVIDERS" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['ollama']['status'])" 2>/dev/null)
  if [ "$OLLAMA" = "ready" ] || [ "$OLLAMA" = "unreachable" ]; then
    pass "Ollama status: $OLLAMA (valid)"
  else
    fail "Ollama status: $OLLAMA (expected ready or unreachable)"
  fi

  curl -sf "http://localhost:${STAGING_PORT}/flight-finder-cli" | grep -q '#!/usr/bin/env bash' && pass "GET /flight-finder-cli ok" || fail "flight-finder-cli broken"
  curl -sf "http://localhost:${STAGING_PORT}/install.sh" | grep -q 'HOST_PORT' && pass "GET /install.sh ok" || fail "install.sh broken"

  # === Test 6: CLI commands ===
  echo ""
  echo "  === CLI commands ==="
  export HOME="$TEST_HOME"
  export PATH="$TEST_HOME/.local/bin:$PATH"
  export HOST_PORT="$STAGING_PORT"

  STATUS_OUT=$(flight-finder status 2>&1 | sed 's/\x1b\[[0-9;]*m//g') || true
  echo "$STATUS_OUT" | grep -qi "running" && pass "flight-finder status: running" || fail "flight-finder status: $STATUS_OUT"

  VERSION_OUT=$(flight-finder version 2>&1 | sed 's/\x1b\[[0-9;]*m//g') || true
  # Assert it reports a semver, not a brand string: the brand was renamed from
  # fairtrail to flightfinder (#96), and a version smoke check should survive
  # the next rebrand too. A missing version (app down) still prints no semver.
  echo "$VERSION_OUT" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+' && pass "flight-finder version: $(echo "$VERSION_OUT" | head -1)" || fail "flight-finder version failed"
fi

# === Report ===
echo ""
echo "  ============================================"
if [ "$FAIL" -eq 0 ]; then
  echo "  Staging: ALL $PASS CHECKS PASSED"
else
  echo "  Staging: $PASS passed, $FAIL FAILED"
fi
echo "  ============================================"
echo ""

[ "$FAIL" -eq 0 ] || exit 1
ENDSSH

EXIT=$?

if [ "$EXIT" -eq 0 ]; then
  printf "\n${GREEN}${BOLD}Staging test passed${RESET}\n\n"
else
  printf "\n${RED}${BOLD}Staging test failed${RESET}\n\n"
fi

exit "$EXIT"
