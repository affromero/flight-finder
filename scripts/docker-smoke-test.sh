#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Docker Smoke Test — Pre-release gate
# ============================================================================
# Builds the Docker image, starts the full stack with an LLMock server,
# and runs the /api/test/scrape endpoint to verify:
#   1. Docker image builds from local source
#   2. Container starts, entrypoint runs, Prisma migrations apply
#   3. DB + Redis connectivity
#   4. Chromium browser launches inside the container
#   5. LLM extraction pipeline works (fixture HTML -> LLMock -> parsed prices)
#   6. Database write + read round-trip
#
# Usage:
#   ./scripts/docker-smoke-test.sh          # Build + test
#   ./scripts/docker-smoke-test.sh --no-build  # Skip build (reuse existing image)
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- Precheck: Docker daemon must be reachable BEFORE any trap is set.
# Without this, `docker compose build` fails on a missing socket and the
# EXIT-trap cleanup masks the failure (the trap returns 0 because of the
# `|| true` in `down`, and bash uses that as the exit code). The release
# gate then reports "passed" even though no checks ran. See
# https://github.com/affromero/flight-finder/pull/...
if ! docker info >/dev/null 2>&1; then
  cat >&2 <<EOF
  [smoke] FATAL Docker daemon is not reachable.

  Start Docker Desktop (macOS) or the docker service (Linux), wait for
  the daemon to come up, and re-run:

      ./scripts/docker-smoke-test.sh

EOF
  exit 1
fi

# --- Config ---
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.test.yml"
CRON_SECRET="smoke-test-secret-$(date +%s)"
HOST_PORT="${SMOKE_TEST_PORT:-3099}"
HEALTH_TIMEOUT=90
TEST_TIMEOUT=120

# --- Parse args ---
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
  esac
done

# --- Helpers ---
info()  { echo "  [smoke] $*"; }
pass()  { echo "  [smoke] PASS $*"; }
fail()  { echo "  [smoke] FAIL $*"; }
fatal() { echo "  [smoke] FATAL $*" >&2; exit 1; }
# Don't call cleanup manually here — the EXIT trap fires it automatically
# with the right $? (1, from this exit), whereas calling cleanup directly
# would let `local status=$?` inside cleanup capture 0 from the prior
# `echo` and then `exit "$status"` would exit successfully, masking the
# fatal we just reported.

cleanup() {
  # Capture the exit status that triggered this trap. Without this, a
  # successful `docker compose down` later in the cleanup overwrites the
  # original failure code and the script reports a false "all checks
  # passed". The trap restores it via `exit "$status"` at the end.
  local status=$?
  info "Tearing down..."
  CRON_SECRET="$CRON_SECRET" HOST_PORT="$HOST_PORT" \
    docker compose $COMPOSE_FILES down -v --remove-orphans 2>/dev/null || true
  # Restore original .env if it existed, otherwise remove the temp one
  if [ "${ENV_EXISTED:-false}" = true ] && [ -f "$REPO_ROOT/.env.smoke-backup" ]; then
    mv "$REPO_ROOT/.env.smoke-backup" "$REPO_ROOT/.env"
  else
    rm -f "$REPO_ROOT/.env" "$REPO_ROOT/.env.smoke-backup"
  fi
  # Propagate the original failure to the shell.
  exit "$status"
}

trap cleanup EXIT

# --- Step 1: Build ---
if [ "$SKIP_BUILD" = false ]; then
  info "Building Docker image from local source..."
  CRON_SECRET="$CRON_SECRET" HOST_PORT="$HOST_PORT" \
    docker compose $COMPOSE_FILES build web
  pass "Docker image built"
else
  info "Skipping build (--no-build)"
fi

# --- Step 2: Start stack ---
info "Starting stack (db + redis + llmock + web) on port $HOST_PORT..."
export CRON_SECRET HOST_PORT
# Write .env so docker-compose env_file directive works
# (the base docker-compose.yml requires env_file: .env)
ENV_FILE="$REPO_ROOT/.env"
ENV_EXISTED=false
[ -f "$ENV_FILE" ] && ENV_EXISTED=true && cp "$ENV_FILE" "$ENV_FILE.smoke-backup"
cat > "$ENV_FILE" <<ENVEOF
CRON_SECRET=$CRON_SECRET
POSTGRES_PASSWORD=smoketest
HOST_PORT=$HOST_PORT
ANTHROPIC_API_KEY=test-smoke-key
ENVEOF

# Use the smoke test .env
CRON_SECRET="$CRON_SECRET" HOST_PORT="$HOST_PORT" POSTGRES_PASSWORD=smoketest \
  docker compose $COMPOSE_FILES up -d

# --- Step 3: Wait for health ---
info "Waiting for /api/health (up to ${HEALTH_TIMEOUT}s)..."
SECONDS_WAITED=0
until curl -sf "http://localhost:${HOST_PORT}/api/health" >/dev/null 2>&1; do
  SECONDS_WAITED=$((SECONDS_WAITED + 2))
  if [ "$SECONDS_WAITED" -ge "$HEALTH_TIMEOUT" ]; then
    fail "Health check timed out after ${HEALTH_TIMEOUT}s"
    info "Container logs:"
    docker compose $COMPOSE_FILES logs web --tail 50
    fatal "App did not become healthy"
  fi
  sleep 2
done
pass "Health check passed (${SECONDS_WAITED}s)"

# --- Step 4: Run smoke test endpoint ---
info "Running /api/test/scrape..."
RESPONSE=$(curl -sf -w "\n%{http_code}" \
  -H "Authorization: Bearer $CRON_SECRET" \
  --max-time "$TEST_TIMEOUT" \
  "http://localhost:${HOST_PORT}/api/test/scrape" 2>&1) || {
    fail "Test endpoint request failed"
    info "Response: $RESPONSE"
    info "Container logs:"
    docker compose $COMPOSE_FILES logs web --tail 50
    fatal "Smoke test endpoint unreachable or errored"
  }

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  fail "Test endpoint returned HTTP $HTTP_CODE"
  info "Body: $BODY"
  info "Container logs:"
  docker compose $COMPOSE_FILES logs web --tail 50
  exit 1
fi

# Parse the ok field from JSON response
OK=$(echo "$BODY" | grep -o '"ok":true' || true)
if [ -z "$OK" ]; then
  fail "Smoke test did not return ok:true"
  info "Body: $BODY"
  exit 1
fi

# --- Step 5: Report ---
echo ""
echo "  ============================================"
echo "  Docker Smoke Test: ALL CHECKS PASSED"
echo "  ============================================"
echo ""

# Pretty-print check details if jq is available
if command -v jq >/dev/null 2>&1; then
  echo "$BODY" | jq -r '.data.checks[] | "  [\(if .passed then "PASS" else "FAIL" end)] \(.name) (\(.durationMs)ms) - \(.detail)"'
  TOTAL_MS=$(echo "$BODY" | jq -r '.data.totalMs')
  echo ""
  info "Total: ${TOTAL_MS}ms"
fi

exit 0
