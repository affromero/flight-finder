#!/usr/bin/env bash
# Migration test: static grep checks on install.sh + flight-finder-cli that
# the ~/.fairtrail -> ~/.flight-finder migration block, deprecated fairtrail
# binary alias, and migrate subcommand are wired up. No Docker required.
#
# A full Docker-based e2e migration test belongs alongside install-e2e-test.sh
# once the seeded fixture is built out.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/apps/web/public/install.sh"
WRAPPER="$REPO_ROOT/apps/web/public/flight-finder-cli"
LEGACY_SHIM="$REPO_ROOT/apps/web/public/fairtrail-cli"

PASS=0
FAIL=0
FAILED_TESTS=()

pass() { PASS=$((PASS + 1)); printf '\033[0;32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); printf '\033[0;31mFAIL\033[0m %s\n' "$1"; }

assert_grep() {
  local pattern="$1"
  local file="$2"
  local label="$3"
  if grep -qE "$pattern" "$file"; then
    pass "$label"
  else
    fail "$label"
  fi
}

# install.sh: migration block
assert_grep 'pre-rename install at ~/\.fairtrail'              "$INSTALLER" "install.sh detects pre-rename ~/.fairtrail layout"
assert_grep 'ALTER DATABASE fairtrail RENAME TO flight_finder' "$INSTALLER" "install.sh runs ALTER DATABASE fairtrail to flight_finder"
assert_grep '\.migrated-from-fairtrail'                        "$INSTALLER" "install.sh writes the migration marker"
assert_grep 'COMPOSE_NAME_LINE'                                "$INSTALLER" "install.sh threads COMPOSE_NAME_LINE through the compose template"
assert_grep 'Both ~/\.fairtrail and ~/\.flight-finder exist'   "$INSTALLER" "install.sh refuses to auto resolve dual-dir state"

# install.sh: new compose defaults (Phase 4 brings POSTGRES_DB / image / DATABASE_URL forward)
assert_grep 'POSTGRES_DB: flight_finder'                       "$INSTALLER" "install.sh generated compose uses POSTGRES_DB flight_finder"
assert_grep 'ghcr\.io/affromero/flight-finder:latest'          "$INSTALLER" "install.sh generated compose pulls ghcr.io/affromero/flight-finder:latest"
assert_grep 'db:5432/flight_finder'                            "$INSTALLER" "install.sh generated compose points DATABASE_URL at flight_finder"

# install.sh: dual canonical + alias + deprecated symlinks in ~/.local/bin
assert_grep 'ln -sf flight-finder "\$INSTALL_BIN/flightfinder"' "$INSTALLER" "install.sh creates flightfinder alias symlink"
assert_grep 'ln -sf flight-finder "\$INSTALL_BIN/fairtrail"'    "$INSTALLER" "install.sh creates deprecated fairtrail symlink"

# Wrapper: deprecation notice + migrate subcommand
assert_grep 'FLIGHT_FINDER_SILENCE_RENAME'                     "$WRAPPER"   "wrapper exposes FLIGHT_FINDER_SILENCE_RENAME to suppress deprecation notice"
assert_grep '_FF_INVOKED_AS="\$\(basename "\$0"\)"'            "$WRAPPER"   "wrapper detects invocation name for deprecation notice"
assert_grep '^cmd_migrate\(\)'                                 "$WRAPPER"   "wrapper defines cmd_migrate function"
assert_grep 'migrate\)[[:space:]]+cmd_migrate'                 "$WRAPPER"   "wrapper dispatches migrate subcommand"

# Legacy /fairtrail-cli shim: a pre-rename `fairtrail update` re-fetches this
# file, so it must prompt to migrate instead of being the old stale CLI (#139).
if [ -f "$LEGACY_SHIM" ]; then pass "legacy fairtrail-cli shim is served from public/"; else fail "legacy fairtrail-cli shim is served from public/"; fi
assert_grep 'renamed at v0\.9\.0'                              "$LEGACY_SHIM" "legacy shim states Fairtrail was renamed to Flight Finder"
assert_grep 'curl -fsSL https://flight-finder\.org/install\.sh \| bash' "$LEGACY_SHIM" "legacy shim points at the install one-liner"
assert_grep 'Migrate now\?'                                    "$LEGACY_SHIM" "legacy shim prompts to migrate when interactive"
assert_grep '\[ -t 0 \] && \[ -t 1 \]'                         "$LEGACY_SHIM" "legacy shim only prompts on a real terminal"
if bash -n "$LEGACY_SHIM" 2>/dev/null; then pass "legacy shim is valid bash"; else fail "legacy shim is valid bash"; fi

echo ""
if [ $FAIL -eq 0 ]; then
  printf '\033[1mResults: \033[0;32m%d passed\033[0m, \033[0;31m0 failed\033[0m\n' $PASS
  exit 0
else
  printf '\033[1mResults: \033[0;32m%d passed\033[0m, \033[0;31m%d failed\033[0m\n' $PASS $FAIL
  for t in "${FAILED_TESTS[@]}"; do
    printf '  - %s\n' "$t"
  done
  exit 1
fi
