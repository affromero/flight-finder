#!/usr/bin/env bash
set -euo pipefail

# Regression tests for the install.sh and flight-finder-cli scripts.
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
# Test: flight-finder update uses `command -v` for self-path detection
# ---------------------------------------------------------------------------
test_update_self_path() {
  local cli="apps/web/public/flight-finder-cli"
  if grep -q 'command -v fairtrail' "$cli" && grep -q 'mkdir -p "\$CLI_DIR"' "$cli"; then
    pass "flight-finder update uses dynamic self-path detection"
  else
    fail "flight-finder update should use 'command -v fairtrail' and mkdir"
  fi
}

# ---------------------------------------------------------------------------
# Test: flight-finder update shows curl errors (no 2>/dev/null on curl)
# ---------------------------------------------------------------------------
test_update_shows_curl_errors() {
  local cli="apps/web/public/flight-finder-cli"
  # The curl line inside cmd_update should NOT end with 2>/dev/null
  local update_curl
  update_curl=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli" | grep 'curl.*flight-finder-cli' | head -1)
  if echo "$update_curl" | grep -q '2>/dev/null'; then
    fail "flight-finder update swallows curl errors with 2>/dev/null"
  else
    pass "flight-finder update shows curl errors"
  fi
}

# ---------------------------------------------------------------------------
# Test: flight-finder update force-recreates the web container after pull (#72)
# ---------------------------------------------------------------------------
# Without --force-recreate, podman-compose does not always detect a digest
# change on :latest after `dc pull web` and skips the recreate, leaving the
# user running the old image even though the pull succeeded.
test_update_force_recreates_web() {
  local cli="apps/web/public/flight-finder-cli"
  local block
  block=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli")

  # The cmd_update block must contain a `dc up -d` line that includes both
  # --force-recreate and --no-deps targeting the `web` service.
  if echo "$block" | grep -E 'dc up -d.*--force-recreate.*--no-deps.*web|dc up -d.*--no-deps.*--force-recreate.*web' >/dev/null; then
    pass "flight-finder update force-recreates web after pull (#72)"
  else
    fail "flight-finder update should run 'dc up -d --force-recreate --no-deps web' after pull/build (#72)"
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
# Test: flight-finder-cli dispatches Ink TUI flags to docker exec
# ---------------------------------------------------------------------------
test_cli_dispatches_tui_flags() {
  local cli="apps/web/public/flight-finder-cli"
  if grep -q '\-\-headless|\-\-list|\-\-view|\-\-backend|\-\-model' "$cli"; then
    pass "flight-finder-cli dispatches Ink TUI flags"
  else
    fail "flight-finder-cli should dispatch --headless/--list/--view/--backend/--model"
  fi
}

# ---------------------------------------------------------------------------
# Test: flight-finder-cli defines cmd_tui with TTY detection
# ---------------------------------------------------------------------------
test_cli_has_cmd_tui() {
  local cli="apps/web/public/flight-finder-cli"
  if grep -q 'cmd_tui()' "$cli" && grep -q 'flight-finder-tui' "$cli"; then
    pass "flight-finder-cli defines cmd_tui that invokes flight-finder-tui"
  else
    fail "flight-finder-cli should define cmd_tui invoking flight-finder-tui"
  fi
}

# ---------------------------------------------------------------------------
# Test: flight-finder-cli ships the multi user recovery commands (#102)
# ---------------------------------------------------------------------------
test_cli_has_recovery_commands() {
  local cli="apps/web/public/flight-finder-cli"

  if grep -q 'cmd_reset_password()' "$cli" && grep -q 'cmd_disable_accounts()' "$cli"; then
    pass "flight-finder-cli defines cmd_reset_password and cmd_disable_accounts (#102)"
  else
    fail "flight-finder-cli should define cmd_reset_password and cmd_disable_accounts (#102)"
  fi

  if grep -qE 'reset-password\)' "$cli" && grep -qE 'disable-accounts\)' "$cli"; then
    pass "flight-finder-cli dispatches reset-password and disable-accounts (#102)"
  else
    fail "flight-finder-cli should dispatch reset-password and disable-accounts (#102)"
  fi

  if grep -q 'flight-finder-tui --reset-password' "$cli" && grep -q 'flight-finder-tui --disable-accounts' "$cli"; then
    pass "recovery commands exec flight-finder-tui with the recovery flags (#102)"
  else
    fail "recovery commands should exec flight-finder-tui --reset-password / --disable-accounts (#102)"
  fi

  if grep -q 'Account recovery' "$cli"; then
    pass "cmd_help documents the account recovery commands (#102)"
  else
    fail "cmd_help should document reset-password and disable-accounts (#102)"
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
# Test: Dockerfile ships flight-finder-tui binary
# ---------------------------------------------------------------------------
test_dockerfile_ships_cli() {
  local dockerfile="Dockerfile"
  if grep -q 'workspace=@flight-finder/cli' "$dockerfile" && grep -q 'flight-finder-tui --help' "$dockerfile"; then
    pass "Dockerfile builds @flight-finder/cli and smoke tests flight-finder-tui"
  else
    fail "Dockerfile should build @flight-finder/cli and run flight-finder-tui --help smoke check"
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
# Test: the runtime entrypoint applies the schema with the BUNDLED prisma CLI
# Regression test against the v0.5.2 deploy: `npx prisma` in the runtime
# entrypoint round-trips to the npm registry every startup, and Prisma 7
# dropped `url = env("DATABASE_URL")`, breaking schema parsing until pinned.
# A later regression: even pinned `npx prisma@^6` failed to resolve the CLI at
# runtime (`sh: prisma: not found`), so the schema was never applied.
#
# The fix bundles the CLI in the image (the `prismacli` Dockerfile stage) and
# the entrypoint runs it directly. This test enforces that invariant: no
# runtime `npx prisma`, and the bundled CLI pinned to a major so it never
# silently jumps to a new one.
# ---------------------------------------------------------------------------
test_entrypoint_uses_bundled_pinned_prisma() {
  local entrypoint="docker-entrypoint.sh"
  local dockerfile="Dockerfile"
  local code_only docker_code
  code_only=$(grep -vE '^\s*#' "$entrypoint")
  docker_code=$(grep -vE '^\s*#' "$dockerfile")

  # Entrypoint applies the schema with the bundled CLI, not a runtime fetch.
  if printf '%s\n' "$code_only" | grep -qE 'prisma-cli/node_modules/prisma/build/index\.js'; then
    pass "docker-entrypoint.sh applies the schema with the bundled prisma CLI"
  else
    fail "docker-entrypoint.sh must run the bundled prisma CLI (/app/prisma-cli/.../build/index.js) for db push"
  fi

  # Forbid any runtime 'npx prisma' (pinned or not) — it round-trips the registry.
  if printf '%s\n' "$code_only" | grep -qE 'npx +prisma'; then
    fail "docker-entrypoint.sh must not run 'npx prisma' at runtime; use the bundled CLI"
  fi

  # The bundled CLI must be pinned to a major in the prismacli stage.
  if printf '%s\n' "$docker_code" | grep -qE 'npm install .*prisma@(\^|~)?[0-9]'; then
    pass "Dockerfile pins the bundled prisma CLI to a major version"
  else
    fail "Dockerfile prismacli stage must pin prisma (e.g. 'npm install ... prisma@6')"
  fi
  if printf '%s\n' "$docker_code" | grep -qE 'prisma@latest'; then
    fail "Dockerfile must not install prisma@latest (silently picks up new majors)"
  fi
}

# ---------------------------------------------------------------------------
# Test: app defaults to self-hosted; CLI install decoupled from app mode (#89)
# The Next.js app reads process.env.SELF_HOSTED at runtime. The entrypoint must
# EXPORT it (defaulting true) so a compose that omits the var still runs the app
# self-hosted; otherwise canManageQueryWithoutToken returns false and per-tracker
# edit controls hide on token-less browsers (the migrated-legacy-tracker bug).
# CLI provider install is gated separately on INSTALL_CLI_PROVIDERS so the one
# hosted deployment (flight-finder.org) stays hosted yet keeps the Claude Code CLI.
# ---------------------------------------------------------------------------
test_entrypoint_self_hosted_default() {
  local entrypoint="docker-entrypoint.sh"
  local prod="docker-compose.prod.yml"
  local code_only
  code_only=$(grep -vE '^\s*#' "$entrypoint")

  # 1. Entrypoint exports SELF_HOSTED with a default of true.
  if printf '%s\n' "$code_only" | grep -qF 'export SELF_HOSTED="${SELF_HOSTED:-true}"'; then
    pass "docker-entrypoint.sh exports SELF_HOSTED defaulting to true (#89)"
  else
    fail "docker-entrypoint.sh must 'export SELF_HOSTED=\"\${SELF_HOSTED:-true}\"' so the app defaults to self-hosted (#89)"
  fi

  # 2. CLI install is gated on INSTALL_CLI_PROVIDERS, not SELF_HOSTED.
  if printf '%s\n' "$code_only" | grep -qF '"$INSTALL_CLI_PROVIDERS" = "true"'; then
    pass "docker-entrypoint.sh gates CLI install on INSTALL_CLI_PROVIDERS (#89)"
  else
    fail "docker-entrypoint.sh must gate CLI provider install on INSTALL_CLI_PROVIDERS, decoupled from SELF_HOSTED (#89)"
  fi

  # 3. The one hosted deployment opts out explicitly and keeps CLI install.
  if grep -qE '^\s*SELF_HOSTED:\s*"false"' "$prod" && grep -qE '^\s*INSTALL_CLI_PROVIDERS:\s*"true"' "$prod"; then
    pass "docker-compose.prod.yml sets SELF_HOSTED=false + INSTALL_CLI_PROVIDERS=true (#89)"
  else
    fail "docker-compose.prod.yml must explicitly set SELF_HOSTED=\"false\" and INSTALL_CLI_PROVIDERS=\"true\" (#89)"
  fi
}

# ---------------------------------------------------------------------------
# Test: _compose_exec_flags emits the right flags for each compose flavor
# (issue #72 follow-up). docker compose, docker-compose, and podman compose
# accept Docker's -it/-i; podman-compose (standalone Python tool) rejects
# them and uses -T to disable TTY.
# ---------------------------------------------------------------------------
test_compose_exec_flags_matrix() {
  local helper="apps/web/public/flight-finder-cli-flags.sh"
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
  local cli="apps/web/public/flight-finder-cli"
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
  local cli="apps/web/public/flight-finder-cli"
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
  local cli="apps/web/public/flight-finder-cli"

  if grep -q 'flight-finder-cli-flags.sh' "$installer"; then
    pass "install.sh ships flight-finder-cli-flags.sh"
  else
    fail "install.sh must download/copy flight-finder-cli-flags.sh next to flight-finder (#72)"
  fi

  local update_block
  update_block=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli")
  if echo "$update_block" | grep -q 'flight-finder-cli-flags.sh'; then
    pass "cmd_update refreshes flight-finder-cli-flags.sh"
  else
    fail "cmd_update must refresh flight-finder-cli-flags.sh alongside the CLI (#72)"
  fi
}

test_env_merge_non_destructive() {
  local installer="apps/web/public/install.sh"

  # Re-running with an existing .env must merge missing keys, not skip wholesale (#152).
  if grep -q 'append_env_if_missing' "$installer"; then
    pass "install.sh merges new keys into an existing .env (#152)"
  else
    fail "install.sh should non-destructively merge new keys into an existing .env (#152)"
  fi

  # The merge must guard on the key being absent (^KEY=) so existing lines are never clobbered.
  if grep -qF '^${_key}=' "$installer"; then
    pass "install.sh .env merge checks '^KEY=' before appending (no clobber)"
  else
    fail "install.sh .env merge must check '^KEY=' before appending so it never clobbers"
  fi

  # The detected provider key and OLLAMA_HOST are both merge candidates.
  if grep -qF 'append_env_if_missing "$API_KEY_VAR"' "$installer" \
     && grep -qF 'append_env_if_missing "OLLAMA_HOST"' "$installer"; then
    pass "install.sh .env merge covers the provider key and OLLAMA_HOST"
  else
    fail "install.sh .env merge should cover API_KEY_VAR and OLLAMA_HOST"
  fi

  # Clear messaging either way.
  if grep -q 'no new keys to add' "$installer" && grep -q 'new key(s)' "$installer"; then
    pass "install.sh reports whether .env keys were added or left unchanged"
  else
    fail "install.sh should report added keys or that nothing changed"
  fi
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
echo ""
printf "${BOLD}Flight Finder install flow regression tests${RESET}\n"
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
test_cli_has_recovery_commands
test_install_supports_no_browser
test_dockerfile_ships_cli
test_install_supports_arch_family
test_entrypoint_uses_bundled_pinned_prisma
test_entrypoint_self_hosted_default
test_compose_exec_flags_matrix
test_cmd_tui_uses_helper
test_no_raw_it_flags_in_dc_exec
test_helper_shipped_by_install_and_update
test_env_merge_non_destructive

echo ""
printf "${BOLD}Results: ${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
