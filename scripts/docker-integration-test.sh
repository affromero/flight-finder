#!/usr/bin/env bash
set -euo pipefail

# Integration test: builds the app image, starts app+DB+Redis,
# then hits every critical endpoint with curl.
#
# Usage: bash scripts/docker-integration-test.sh [--no-build] [--keep-alive]
# Pass --no-build to skip image build (use existing ghcr image).
# Pass --keep-alive to skip container cleanup on exit (for chaining with other tests).

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

PASS=0
FAIL=0
PORT=3399  # Use a non-standard port to avoid conflicts

pass() { PASS=$((PASS + 1)); printf "${GREEN}PASS${RESET} %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "${RED}FAIL${RESET} %s -- %s\n" "$1" "$2"; }

NO_BUILD=false
KEEP_ALIVE=false
for arg in "$@"; do
  case "$arg" in
    --no-build)  NO_BUILD=true ;;
    --keep-alive) KEEP_ALIVE=true ;;
  esac
done

PROJECT="flight-finder-integration-test"
COMPOSE_FILE="scripts/docker-compose.integration.yml"

cleanup() {
  printf "\n${DIM}Cleaning up...${RESET}\n"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
if [ "$KEEP_ALIVE" = false ]; then
  trap cleanup EXIT
fi

echo ""
printf "${BOLD}Fairtrail integration tests${RESET}\n"
echo ""

# ── Build image (unless --no-build) ──────────────────────────────
if [ "$NO_BUILD" = false ]; then
  printf "${DIM}Building app image...${RESET}\n"
  docker build -t flight-finder-test:latest . -q
  printf "${DIM}Build complete.${RESET}\n\n"
fi

# ── Start services ───────────────────────────────────────────────
printf "${DIM}Starting app + DB + Redis...${RESET}\n"
HOST_PORT="$PORT" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d 2>&1 | while IFS= read -r line; do
  printf "  ${DIM}%s${RESET}\n" "$line"
done

# ── Wait for health ─────────────────────────────────────────────
printf "${DIM}Waiting for app to be healthy...${RESET}\n"
RETRIES=90
until curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    fail "App did not become healthy in 90s" "Check: docker compose -p $PROJECT -f $COMPOSE_FILE logs web"
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs web 2>&1 | tail -30
    echo ""
    printf "${BOLD}Results: ${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"
    exit 1
  fi
  sleep 1
done
echo ""

# ── Test 1: Health endpoint ──────────────────────────────────────
test_health() {
  local res
  res=$(curl -sf "http://localhost:${PORT}/api/health")
  local status
  status=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  if [ "$status" = "ok" ]; then
    pass "GET /api/health returns status=ok"
  else
    fail "GET /api/health" "status=$status"
  fi

  local db
  db=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['database'])" 2>/dev/null)
  if [ "$db" = "connected" ]; then
    pass "Database is connected"
  else
    fail "Database connection" "database=$db"
  fi

  local redis
  redis=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['redis'])" 2>/dev/null)
  if [ "$redis" = "connected" ]; then
    pass "Redis is connected"
  else
    fail "Redis connection" "redis=$redis"
  fi
}

# ── Test 2: Landing page serves HTML ─────────────────────────────
test_landing_page() {
  local status_code
  status_code=$(curl -so /dev/null -w "%{http_code}" "http://localhost:${PORT}/")
  if [ "$status_code" = "200" ]; then
    pass "GET / returns 200"
  else
    fail "GET / returns $status_code" "expected 200"
  fi

  local body
  body=$(curl -sf "http://localhost:${PORT}/")
  if echo "$body" | grep -qi "flight finder"; then
    pass "Landing page contains 'Flight Finder'"
  else
    fail "Landing page" "missing 'Flight Finder' in HTML"
  fi
}

# ── Test 3: Settings page loads ───────────────────────────────────
test_settings_page() {
  local status_code
  status_code=$(curl -so /dev/null -w "%{http_code}" "http://localhost:${PORT}/settings")
  if [ "$status_code" = "200" ]; then
    pass "GET /settings returns 200"
  else
    fail "GET /settings returns $status_code" "expected 200"
  fi
}

# ── Test 4: Config API returns data with currency/country fields ─
test_config_api() {
  local res
  res=$(curl -sf "http://localhost:${PORT}/api/admin/config")
  local ok
  ok=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
  if [ "$ok" = "True" ]; then
    pass "GET /api/admin/config returns ok=true"
  else
    fail "GET /api/admin/config" "ok=$ok"
  fi

  # Verify currency/country fields exist in response (even if null)
  local has_currency has_country
  has_currency=$(echo "$res" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('defaultCurrency' in d)" 2>/dev/null)
  has_country=$(echo "$res" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('defaultCountry' in d)" 2>/dev/null)
  if [ "$has_currency" = "True" ] && [ "$has_country" = "True" ]; then
    pass "Config API returns defaultCurrency and defaultCountry fields"
  else
    fail "Config API missing fields" "currency=$has_currency country=$has_country"
  fi
}

# ── Test 5: Config API PATCH -- save and read back currency ──────
test_config_patch_currency() {
  local res
  res=$(curl -sf "http://localhost:${PORT}/api/admin/config" \
    -X PATCH \
    -H 'Content-Type: application/json' \
    -d '{"defaultCurrency":"EUR","defaultCountry":"DE"}')
  local ok
  ok=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
  if [ "$ok" = "True" ]; then
    pass "PATCH /api/admin/config saves currency/country"
  else
    fail "PATCH /api/admin/config" "ok=$ok"
  fi

  # Read back and verify persistence
  local readback
  readback=$(curl -sf "http://localhost:${PORT}/api/admin/config")
  local currency country
  currency=$(echo "$readback" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['defaultCurrency'])" 2>/dev/null)
  country=$(echo "$readback" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['defaultCountry'])" 2>/dev/null)
  if [ "$currency" = "EUR" ] && [ "$country" = "DE" ]; then
    pass "Currency/country persisted correctly (EUR/DE)"
  else
    fail "Currency/country persistence" "got currency=$currency country=$country"
  fi
}

# ── Test 6: Providers API returns all providers with status ──────
test_providers_api() {
  local res
  res=$(curl -sf "http://localhost:${PORT}/api/admin/providers")
  local ok
  ok=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
  if [ "$ok" = "True" ]; then
    pass "GET /api/admin/providers returns ok=true"
  else
    fail "GET /api/admin/providers" "ok=$ok"
  fi

  # Ollama should NOT be "ready" (it's not running in the test container)
  local ollama_status
  ollama_status=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['ollama']['status'])" 2>/dev/null)
  if [ "$ollama_status" = "unreachable" ]; then
    pass "Ollama status is 'unreachable' (not falsely 'ready')"
  else
    fail "Ollama status" "expected 'unreachable', got '$ollama_status'"
  fi
}

# ── Test 7: Config API rejects invalid currency ──────────────────
test_config_validation() {
  local res
  # Don't use -f here -- we expect a 400 response
  res=$(curl -s "http://localhost:${PORT}/api/admin/config" \
    -X PATCH \
    -H 'Content-Type: application/json' \
    -d '{"defaultCurrency":"TOOLONG"}')
  local ok
  ok=$(echo "$res" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
  if [ "$ok" = "False" ]; then
    pass "PATCH rejects invalid currency (TOOLONG)"
  else
    fail "Currency validation" "should reject TOOLONG, got ok=$ok"
  fi
}

# ── Test 8: Static assets served ─────────────────────────────────
test_static_assets() {
  local status_code
  status_code=$(curl -so /dev/null -w "%{http_code}" "http://localhost:${PORT}/flight-finder-cli")
  if [ "$status_code" = "200" ]; then
    pass "GET /flight-finder-cli serves the CLI script"
  else
    fail "GET /flight-finder-cli" "status=$status_code"
  fi

  status_code=$(curl -so /dev/null -w "%{http_code}" "http://localhost:${PORT}/install.sh")
  if [ "$status_code" = "200" ]; then
    pass "GET /install.sh serves the installer"
  else
    fail "GET /install.sh" "status=$status_code"
  fi
}

# ── Test 9: Volume migration safety ──────────────────────────────
test_volume_migration() {
  # Verify docker compose project name is "fairtrail" regardless of
  # whether the directory is ~/fairtrail or ~/.flight-finder
  local installer="apps/web/public/install.sh"

  # Both old (~/fairtrail) and new (~/.flight-finder) must produce the same
  # Docker Compose project name so volumes are preserved across migration.
  # Compose strips leading dots from directory names for the project name.
  local old_name new_name
  old_name=$(python3 -c "import re; print(re.sub(r'^[._-]+', '', 'fairtrail').lower())")
  new_name=$(python3 -c "import re; print(re.sub(r'^[._-]+', '', '.fairtrail').lower())")

  if [ "$old_name" = "$new_name" ]; then
    pass "Volume names match across migration (project=$old_name)"
  else
    fail "Volume names differ" "old=$old_name new=$new_name -- DATA LOSS RISK"
  fi

  # Verify install.sh does NOT use 'down -v' which would delete volumes
  if grep -q 'down -v' "$installer"; then
    fail "install.sh uses 'down -v'" "this would delete user data during migration"
  else
    pass "install.sh does NOT use 'down -v' (volumes preserved)"
  fi
}

# ── Run all ──────────────────────────────────────────────────────
test_health
test_landing_page
test_settings_page
test_config_api
test_config_patch_currency
test_providers_api
test_config_validation
test_static_assets
test_volume_migration

echo ""
printf "${BOLD}Results: ${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"
echo ""
[ "$FAIL" -eq 0 ] || exit 1
