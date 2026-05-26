#!/usr/bin/env bash
set -euo pipefail

# Regression tests for the install.sh and fairtrail-cli scripts.
# Runs locally — does NOT execute Docker or hit the network.

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "${GREEN}PASS${RESET} %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "${RED}FAIL${RESET} %s\n" "$1"; }

# ---------------------------------------------------------------------------
# Test: fairtrail update uses `command -v` for self-path detection
# ---------------------------------------------------------------------------
test_update_self_path() {
  local cli="apps/web/public/fairtrail-cli"
  if grep -q 'command -v fairtrail' "$cli" && grep -q 'mkdir -p "\$CLI_DIR"' "$cli"; then
    pass "fairtrail update uses dynamic self-path detection"
  else
    fail "fairtrail update should use 'command -v fairtrail' and mkdir"
  fi
}

# ---------------------------------------------------------------------------
# Test: fairtrail update shows curl errors (no 2>/dev/null on curl)
# ---------------------------------------------------------------------------
test_update_shows_curl_errors() {
  local cli="apps/web/public/fairtrail-cli"
  # The curl line inside cmd_update should NOT end with 2>/dev/null
  local update_curl
  update_curl=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli" | grep 'curl.*fairtrail-cli' | head -1)
  if echo "$update_curl" | grep -q '2>/dev/null'; then
    fail "fairtrail update swallows curl errors with 2>/dev/null"
  else
    pass "fairtrail update shows curl errors"
  fi
}

# ---------------------------------------------------------------------------
# Test: fairtrail update force-recreates the web container after pull (#72)
# ---------------------------------------------------------------------------
# Without --force-recreate, podman-compose does not always detect a digest
# change on :latest after `dc pull web` and skips the recreate, leaving the
# user running the old image even though the pull succeeded.
test_update_force_recreates_web() {
  local cli="apps/web/public/fairtrail-cli"
  local block
  block=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli")

  # The cmd_update block must contain a `dc up -d` line that includes both
  # --force-recreate and --no-deps targeting the `web` service.
  if echo "$block" | grep -E 'dc up -d.*--force-recreate.*--no-deps.*web|dc up -d.*--no-deps.*--force-recreate.*web' >/dev/null; then
    pass "fairtrail update force-recreates web after pull (#72)"
  else
    fail "fairtrail update should run 'dc up -d --force-recreate --no-deps web' after pull/build (#72)"
  fi
}

# ---------------------------------------------------------------------------
# Test: install.sh patches both .bashrc and .profile
# ---------------------------------------------------------------------------
test_path_patches_both_files() {
  local installer="apps/web/public/install.sh"
  local bashrc_patch profile_patch
  bashrc_patch=$(grep -c '\.bashrc' "$installer" || true)
  profile_patch=$(grep -c '\.profile\|\.bash_profile' "$installer" || true)
  if [ "$bashrc_patch" -gt 0 ] && [ "$profile_patch" -gt 0 ]; then
    pass "install.sh patches both .bashrc and .profile/.bash_profile"
  else
    fail "install.sh should patch both .bashrc and .profile/.bash_profile"
  fi
}

# ---------------------------------------------------------------------------
# Test: install.sh handles old ~/fairtrail directory
# ---------------------------------------------------------------------------
test_old_dir_migration() {
  local installer="apps/web/public/install.sh"
  if grep -q 'fairtrail.old-backup' "$installer" && grep -q 'docker-compose.yml' "$installer"; then
    pass "install.sh migrates old ~/fairtrail directory"
  else
    fail "install.sh should handle old ~/fairtrail migration"
  fi
}

# ---------------------------------------------------------------------------
# Test: .env.example documents HOST_PORT
# ---------------------------------------------------------------------------
test_env_host_port() {
  if grep -q 'HOST_PORT' ".env.example"; then
    pass ".env.example documents HOST_PORT"
  else
    fail ".env.example should document HOST_PORT"
  fi
}

# ---------------------------------------------------------------------------
# Test: docker-entrypoint.sh warns on PORT != 3003
# ---------------------------------------------------------------------------
test_entrypoint_port_warning() {
  if grep -q 'PORT.*3003' "docker-entrypoint.sh"; then
    pass "docker-entrypoint.sh references PORT=3003"
  else
    fail "docker-entrypoint.sh should enforce PORT=3003"
  fi
}

# ---------------------------------------------------------------------------
# Test: install.sh has test overrides for CI
# ---------------------------------------------------------------------------
test_install_overrides() {
  local installer="apps/web/public/install.sh"
  if grep -q 'FLIGHT_FINDER_REPO' "$installer" && grep -q 'FLIGHT_FINDER_CLI_SOURCE' "$installer"; then
    pass "install.sh supports test overrides (FLIGHT_FINDER_REPO, FLIGHT_FINDER_CLI_SOURCE)"
  else
    fail "install.sh should support FLIGHT_FINDER_REPO and FLIGHT_FINDER_CLI_SOURCE overrides"
  fi
}

# ---------------------------------------------------------------------------
# Test: install.sh ANSI formatting variables are all defined
# The script uses set -euo pipefail, so any ${VAR} in a printf where VAR
# is an ANSI code that was never assigned will crash at runtime.
# ---------------------------------------------------------------------------
test_ansi_variables_defined() {
  local installer="apps/web/public/install.sh"

  # Known ANSI variable names used in formatting
  local ansi_vars="BOLD DIM UNDERLINE CYAN GREEN YELLOW RED RESET"

  # Extract all top-level assignments (lines like VAR='...')
  local defined
  defined=$(grep -oE '^[A-Z_]+=' "$installer" | sed 's/=$//')

  local missing=""
  for var in $ansi_vars; do
    # Check if the variable is actually referenced in the script
    if grep -q "\${${var}}\|\$${var}" "$installer"; then
      # It's used -- make sure it's defined
      if ! echo "$defined" | grep -qx "$var"; then
        missing+="  $var (used but never assigned)"$'\n'
      fi
    fi
  done

  if [ -z "$missing" ]; then
    pass "install.sh ANSI formatting variables are all defined"
  else
    fail "install.sh has undefined ANSI variables (will crash with set -u):"
    printf "%s" "$missing"
  fi
}

# ---------------------------------------------------------------------------
# Test: fairtrail-cli dispatches Ink TUI flags to docker exec
# ---------------------------------------------------------------------------
test_cli_dispatches_tui_flags() {
  local cli="apps/web/public/fairtrail-cli"
  if grep -q '\-\-headless|\-\-list|\-\-view|\-\-backend|\-\-model' "$cli"; then
    pass "fairtrail-cli dispatches Ink TUI flags"
  else
    fail "fairtrail-cli should dispatch --headless/--list/--view/--backend/--model"
  fi
}

# ---------------------------------------------------------------------------
# Test: fairtrail-cli defines cmd_tui with TTY detection
# ---------------------------------------------------------------------------
test_cli_has_cmd_tui() {
  local cli="apps/web/public/fairtrail-cli"
  if grep -q 'cmd_tui()' "$cli" && grep -q 'fairtrail-tui' "$cli"; then
    pass "fairtrail-cli defines cmd_tui that invokes fairtrail-tui"
  else
    fail "fairtrail-cli should define cmd_tui invoking fairtrail-tui"
  fi
}

# ---------------------------------------------------------------------------
# Test: install.sh supports --no-browser flag
# ---------------------------------------------------------------------------
test_install_supports_no_browser() {
  local installer="apps/web/public/install.sh"
  if grep -q '\-\-no-browser' "$installer" && grep -q 'FLIGHT_FINDER_OPEN_BROWSER' "$installer"; then
    pass "install.sh supports --no-browser flag"
  else
    fail "install.sh should support --no-browser flag"
  fi
}

# ---------------------------------------------------------------------------
# Test: Dockerfile ships fairtrail-tui binary
# ---------------------------------------------------------------------------
test_dockerfile_ships_cli() {
  local dockerfile="Dockerfile"
  if grep -q 'workspace=@flight-finder/cli' "$dockerfile" && grep -q 'fairtrail-tui --help' "$dockerfile"; then
    pass "Dockerfile builds @flight-finder/cli and smoke tests fairtrail-tui"
  else
    fail "Dockerfile should build @flight-finder/cli and run fairtrail-tui --help smoke check"
  fi
}

# ---------------------------------------------------------------------------
# Test: install.sh installs Docker via pacman on Arch-family distros
# Regression test for issue #62: get.docker.com rejects Manjaro/Arch,
# so the installer must detect the Arch family and use pacman instead.
# ---------------------------------------------------------------------------
test_install_supports_arch_family() {
  local installer="apps/web/public/install.sh"
  local has_detection has_pacman_branch has_git_hint
  has_detection=$(grep -c 'DISTRO_FAMILY="arch"' "$installer" || true)
  has_pacman_branch=$(grep -c 'pacman .* docker' "$installer" || true)
  has_git_hint=$(grep -c 'pacman -S git' "$installer" || true)
  if [ "$has_detection" -ge 1 ] && [ "$has_pacman_branch" -ge 1 ] && [ "$has_git_hint" -ge 1 ]; then
    pass "install.sh detects Arch family and installs Docker + git via pacman"
  else
    fail "install.sh should detect Arch family (DISTRO_FAMILY=arch), install Docker via pacman, and hint pacman -S git"
  fi
}

# ---------------------------------------------------------------------------
# Test: docker-entrypoint.sh pins the prisma major version
# Regression test against the v0.5.2 deploy: `npx prisma` (no version)
# in the runtime entrypoint round-trips to the npm registry every startup
# and Prisma 7 dropped `url = env("DATABASE_URL")`, breaking schema
# parsing on every startup until pinned.
#
# Bundling the CLI in the runtime image is the proper fix but requires
# also bundling its transitive deps (effect, @prisma/config, ...). Until
# that lands, the version pin is the cheap insurance.
# ---------------------------------------------------------------------------
test_entrypoint_pins_prisma_major() {
  local entrypoint="docker-entrypoint.sh"
  local code_only
  code_only=$(grep -vE '^\s*#' "$entrypoint")
  if printf '%s\n' "$code_only" | grep -qE 'npx prisma@(\^|~)?[0-9]'; then
    pass "docker-entrypoint.sh pins the prisma major version"
  else
    fail "docker-entrypoint.sh must pin prisma (e.g. 'npx prisma@^6 db push'), never run unpinned 'npx prisma'"
  fi
  # Specifically forbid unpinned 'npx prisma' (no @version) inside code.
  if printf '%s\n' "$code_only" | grep -qE 'npx prisma( |$)'; then
    fail "docker-entrypoint.sh contains unpinned 'npx prisma' which silently picks up new majors"
  fi
}

# ---------------------------------------------------------------------------
# Test: _compose_exec_flags emits the right flags for each compose flavor
# (issue #72 follow-up). docker compose, docker-compose, and podman compose
# accept Docker's -it/-i; podman-compose (standalone Python tool) rejects
# them and uses -T to disable TTY.
# ---------------------------------------------------------------------------
test_compose_exec_flags_matrix() {
  local helper="apps/web/public/fairtrail-cli-flags.sh"
  if [ ! -f "$helper" ]; then
    fail "missing helper file $helper"
    return
  fi

  # Source in a subshell so set -u from the parent doesn't leak in.
  local out
  out=$(bash -c "source $helper
    printf 'docker-compose +tty=[%s]\n'  \"\$(_compose_exec_flags 'docker-compose' 1 1)\"
    printf 'docker-compose -tty=[%s]\n'  \"\$(_compose_exec_flags 'docker-compose' 0 0)\"
    printf 'docker-compose-v2 +tty=[%s]\n' \"\$(_compose_exec_flags 'docker compose' 1 1)\"
    printf 'docker-compose-v2 -tty=[%s]\n' \"\$(_compose_exec_flags 'docker compose' 0 0)\"
    printf 'podman-native +tty=[%s]\n'  \"\$(_compose_exec_flags 'podman compose' 1 1)\"
    printf 'podman-native -tty=[%s]\n'  \"\$(_compose_exec_flags 'podman compose' 0 0)\"
    printf 'podman-compose +tty=[%s]\n' \"\$(_compose_exec_flags 'podman-compose' 1 1)\"
    printf 'podman-compose -tty=[%s]\n' \"\$(_compose_exec_flags 'podman-compose' 0 0)\"
  ")

  local expected
  expected=$(cat <<'EXPECTED'
docker-compose +tty=[-it]
docker-compose -tty=[-i]
docker-compose-v2 +tty=[-it]
docker-compose-v2 -tty=[-i]
podman-native +tty=[-it]
podman-native -tty=[-i]
podman-compose +tty=[]
podman-compose -tty=[-T]
EXPECTED
)

  if [ "$out" = "$expected" ]; then
    pass "_compose_exec_flags emits correct flags across the 4-flavor x 2-tty matrix (#72)"
  else
    fail "_compose_exec_flags matrix mismatch (#72)"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$out") || true
  fi

  # Unknown compose flavors must hard-fail (return non-zero) so a future
  # `nerdctl compose` / `finch compose` doesn't silently inherit docker
  # flags. Anyone adding a new flavor must register it explicitly.
  local rc=0
  bash -c "source $helper; _compose_exec_flags 'nerdctl compose' 0 0" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "_compose_exec_flags rejects unknown compose flavor (#72)"
  else
    fail "_compose_exec_flags must hard-fail on unknown compose flavor — got rc=$rc"
  fi
}

# ---------------------------------------------------------------------------
# Test: cmd_tui delegates exec-flag selection to _compose_exec_flags
# (so future rewrites can't bypass the helper and re-introduce hardcoded -it)
# ---------------------------------------------------------------------------
test_cmd_tui_uses_helper() {
  local cli="apps/web/public/fairtrail-cli"
  local code_only
  # Strip comment lines (leading-whitespace-then-#) so a "see _compose_exec_flags"
  # comment can't satisfy the assertion on its own.
  code_only=$(sed -n '/^cmd_tui()/,/^}/p' "$cli" | grep -vE '^[[:space:]]*#')
  if echo "$code_only" | grep -q '_compose_exec_flags'; then
    pass "cmd_tui calls _compose_exec_flags (#72)"
  else
    fail "cmd_tui must call _compose_exec_flags to pick exec flags by compose flavor (#72)"
  fi
}

# ---------------------------------------------------------------------------
# Test: no raw -it/-i flags survive in any \$_DC exec call site
# (catches future commands that bypass the helper)
# ---------------------------------------------------------------------------
test_no_raw_it_flags_in_dc_exec() {
  local cli="apps/web/public/fairtrail-cli"
  # Strip comment-only lines first, then look for any literal -it / -i  flag
  # passed to `$_DC ... exec` on the same line. The bug we're guarding against
  # is hardcoded -it that survives the helper indirection — so also flag
  # `exec_flags="-it"` style assignments that funnel into the same call.
  local code_only hits
  code_only=$(grep -vE '^[[:space:]]*#' "$cli")
  hits=$(printf '%s\n' "$code_only" \
    | grep -nE '(\$_DC[^#]*[[:space:]]exec[[:space:]]+(-it|-i[[:space:]]))|exec_flags=("|'"'"')-(it|i)("|'"'"')' \
    || true)
  if [ -z "$hits" ]; then
    pass "no raw -it/-i flags in \$_DC exec call sites (#72)"
  else
    fail "found raw -it/-i flags in \$_DC exec — must use _compose_exec_flags helper:"
    printf "%s\n" "$hits"
  fi
}

# ---------------------------------------------------------------------------
# Test: the helper file is shipped by install.sh and refreshed by cmd_update
# (the CLI hard-fails on startup if the helper is missing, so install must
# place it and update must refresh it)
# ---------------------------------------------------------------------------
test_helper_shipped_by_install_and_update() {
  local installer="apps/web/public/install.sh"
  local cli="apps/web/public/fairtrail-cli"

  if grep -q 'fairtrail-cli-flags.sh' "$installer"; then
    pass "install.sh ships fairtrail-cli-flags.sh"
  else
    fail "install.sh must download/copy fairtrail-cli-flags.sh next to fairtrail (#72)"
  fi

  local update_block
  update_block=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli")
  if echo "$update_block" | grep -q 'fairtrail-cli-flags.sh'; then
    pass "cmd_update refreshes fairtrail-cli-flags.sh"
  else
    fail "cmd_update must refresh fairtrail-cli-flags.sh alongside the CLI (#72)"
  fi
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
echo ""
printf "${BOLD}Fairtrail install flow regression tests${RESET}\n"
echo ""

test_update_self_path
test_update_shows_curl_errors
test_update_force_recreates_web
test_path_patches_both_files
test_old_dir_migration
test_env_host_port
test_entrypoint_port_warning
test_install_overrides
test_ansi_variables_defined
test_cli_dispatches_tui_flags
test_cli_has_cmd_tui
test_install_supports_no_browser
test_dockerfile_ships_cli
test_install_supports_arch_family
test_entrypoint_pins_prisma_major
test_compose_exec_flags_matrix
test_cmd_tui_uses_helper
test_no_raw_it_flags_in_dc_exec
test_helper_shipped_by_install_and_update

echo ""
printf "${BOLD}Results: ${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
