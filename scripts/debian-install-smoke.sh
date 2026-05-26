#!/usr/bin/env bash
set -euo pipefail

# Smoke tests that run inside a fresh Debian container.
# Validates install.sh behavior without Docker-in-Docker.

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf "${GREEN}PASS${RESET} %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "${RED}FAIL${RESET} %s -- %s\n" "$1" "$2"; }

echo ""
printf "${BOLD}Debian install smoke tests${RESET}\n"
echo ""

# ──────────────────────────────────────────────────────────────────
# Test 1: PATH patching writes to both .bashrc and .profile
# ──────────────────────────────────────────────────────────────────
test_path_patching() {
  # Set up: ensure .bashrc exists (Debian default), no .bash_profile
  echo "# default bashrc" > "$HOME/.bashrc"
  echo "# default profile" > "$HOME/.profile"
  rm -f "$HOME/.bash_profile"

  # Extract just the PATH-patching section from install.sh and run it.
  # We simulate the condition where ~/.local/bin is NOT in PATH.
  local snippet
  snippet=$(sed -n '/^# Ensure ~\/.local\/bin is in PATH/,/^fi$/p' /home/testuser/install.sh)

  # Run the snippet with PATH that does NOT contain .local/bin
  (
    export HOME="$HOME"
    export INSTALL_BIN="$HOME/.local/bin"
    export PATH="/usr/bin:/bin"
    export SHELL="/bin/bash"
    # Source helper functions needed by the snippet
    ok() { true; }
    warn() { true; }
    BOLD="" RESET=""
    export -f ok warn
    eval "$snippet"
  )

  # Verify .bashrc was patched
  if grep -qF '.local/bin' "$HOME/.bashrc"; then
    pass "PATH patched in .bashrc"
  else
    fail "PATH NOT patched in .bashrc" "grep found nothing"
  fi

  # Verify .profile was also patched (the SSH login shell fix)
  if grep -qF '.local/bin' "$HOME/.profile"; then
    pass "PATH patched in .profile"
  else
    fail "PATH NOT patched in .profile" "SSH login shells won't find fairtrail"
  fi
}

# ──────────────────────────────────────────────────────────────────
# Test 2: Duplicate PATH entries are not added
# ──────────────────────────────────────────────────────────────────
test_no_duplicate_path() {
  # Set up: .bashrc and .profile already have .local/bin
  echo '# default bashrc' > "$HOME/.bashrc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  echo '# default profile' > "$HOME/.profile"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"

  local snippet
  snippet=$(sed -n '/^# Ensure ~\/.local\/bin is in PATH/,/^fi$/p' /home/testuser/install.sh)

  (
    export HOME="$HOME"
    export INSTALL_BIN="$HOME/.local/bin"
    export PATH="/usr/bin:/bin"
    export SHELL="/bin/bash"
    ok() { true; }
    warn() { true; }
    BOLD="" RESET=""
    export -f ok warn
    eval "$snippet"
  )

  local count_bashrc count_profile
  count_bashrc=$(grep -cF '.local/bin' "$HOME/.bashrc")
  count_profile=$(grep -cF '.local/bin' "$HOME/.profile")

  if [ "$count_bashrc" -eq 1 ]; then
    pass "No duplicate PATH in .bashrc"
  else
    fail "Duplicate PATH in .bashrc" "found $count_bashrc entries"
  fi

  if [ "$count_profile" -eq 1 ]; then
    pass "No duplicate PATH in .profile"
  else
    fail "Duplicate PATH in .profile" "found $count_profile entries"
  fi
}

# ──────────────────────────────────────────────────────────────────
# Test 3: PATH is available in SSH login shell (bash -l)
# ──────────────────────────────────────────────────────────────────
test_login_shell_path() {
  # Set up clean files and patch them
  echo "# default bashrc" > "$HOME/.bashrc"
  echo "# default profile" > "$HOME/.profile"
  rm -f "$HOME/.bash_profile"

  local snippet
  snippet=$(sed -n '/^# Ensure ~\/.local\/bin is in PATH/,/^fi$/p' /home/testuser/install.sh)

  (
    export HOME="$HOME"
    export INSTALL_BIN="$HOME/.local/bin"
    export PATH="/usr/bin:/bin"
    export SHELL="/bin/bash"
    ok() { true; }
    warn() { true; }
    BOLD="" RESET=""
    export -f ok warn
    eval "$snippet"
  )

  # Create a dummy flight-finder binary (canonical post-rename)
  mkdir -p "$HOME/.local/bin"
  echo '#!/bin/bash' > "$HOME/.local/bin/flight-finder"
  echo 'echo "flight-finder-ok"' >> "$HOME/.local/bin/flight-finder"
  chmod +x "$HOME/.local/bin/flight-finder"

  # Test: can a login shell find flight-finder?
  local result
  result=$(bash -l -c 'command -v flight-finder 2>/dev/null || echo "not-found"')

  if [ "$result" != "not-found" ]; then
    pass "Login shell (bash -l) finds flight-finder in PATH"
  else
    fail "Login shell (bash -l) cannot find flight-finder" "This is the SSH session bug"
  fi

  rm -rf "$HOME/.local"
}

# ──────────────────────────────────────────────────────────────────
# Test 4: Old ~/fairtrail dir gets renamed
# ──────────────────────────────────────────────────────────────────
test_old_dir_migration() {
  # Create fake old install dir
  mkdir -p "$HOME/fairtrail"
  echo "version: '3'" > "$HOME/fairtrail/docker-compose.yml"
  rm -rf "$HOME/.flight-finder"

  # The migration section of install.sh:
  # - Should rename ~/fairtrail to ~/fairtrail.old-backup in non-interactive mode
  local snippet
  snippet=$(sed -n '/^if \[ -d "\$HOME\/fairtrail" \]/,/^fi$/p' /home/testuser/install.sh)

  (
    export HOME="$HOME"
    export FLIGHT_FINDER_DIR="$HOME/.flight-finder"
    export FLIGHT_FINDER_YES=1  # non-interactive
    # Mock docker compose (not available in this container)
    DC="echo"
    info() { true; }
    ok() { true; }
    warn() { true; }
    BOLD="" DIM="" RESET=""
    export -f info ok warn
    eval "$snippet"
  )

  if [ -d "$HOME/fairtrail.old-backup" ]; then
    pass "Old ~/fairtrail renamed to ~/fairtrail.old-backup"
  else
    fail "Old ~/fairtrail not renamed" "directory should have been moved"
  fi

  if [ ! -d "$HOME/fairtrail" ]; then
    pass "Original ~/fairtrail no longer exists"
  else
    fail "Original ~/fairtrail still exists" "should have been moved"
  fi

  # Cleanup
  rm -rf "$HOME/fairtrail" "$HOME/fairtrail.old-backup" "$HOME/.flight-finder"
}

# ──────────────────────────────────────────────────────────────────
# Test 5: flight-finder-cli update uses command -v, not hardcoded path
# ──────────────────────────────────────────────────────────────────
test_cli_update_path() {
  local cli="/home/testuser/flight-finder-cli"

  # Check cmd_update function uses command -v (canonical flight-finder name).
  # Widened to -A8 to allow a multi-line comment explaining the legacy fallback.
  if grep -A8 'cmd_update' "$cli" | grep -q 'command -v flight-finder'; then
    pass "CLI update uses 'command -v' for self-path detection"
  else
    fail "CLI update hardcodes path" "should use command -v"
  fi

  # Check it doesn't swallow curl errors
  local update_section
  update_section=$(sed -n '/^cmd_update/,/^cmd_/p' "$cli")
  local curl_line
  curl_line=$(echo "$update_section" | grep 'curl.*flight-finder-cli' | head -1)
  if echo "$curl_line" | grep -q '2>/dev/null'; then
    fail "CLI update swallows curl errors" "2>/dev/null found on download line"
  else
    pass "CLI update shows curl errors"
  fi
}

# ──────────────────────────────────────────────────────────────────
# Test 6: Generated .env includes HOST_PORT documentation
# ──────────────────────────────────────────────────────────────────
test_env_host_port() {
  local installer="/home/testuser/install.sh"
  if grep -q 'HOST_PORT=' "$installer" && grep -q 'do NOT set PORT' "$installer"; then
    pass "Generated .env documents HOST_PORT and warns about PORT"
  else
    fail "install.sh missing HOST_PORT documentation" "users will set PORT by mistake"
  fi
}

# ──────────────────────────────────────────────────────────────────
# Test 7: End-to-end installer run (non-interactive, no Docker)
#   Simulates: FLIGHT_FINDER_YES=1 bash install.sh
#   Can't actually run Docker inside this container, but we can
#   test every step up to "docker compose pull" by stubbing Docker.
# ──────────────────────────────────────────────────────────────────
test_e2e_install() {
  # Clean slate
  rm -rf "$HOME/.flight-finder" "$HOME/.local/bin/flight-finder" "$HOME/fairtrail"
  rm -f "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile"
  echo "# default" > "$HOME/.bashrc"
  echo "# default" > "$HOME/.profile"
  mkdir -p "$HOME/.local/bin"

  # Create stub "docker" that fakes success for compose commands
  mkdir -p "$HOME/bin"
  cat > "$HOME/bin/docker" << 'STUB'
#!/bin/bash
case "$*" in
  *"compose version"*) echo "Docker Compose version v2.24.0" ;;
  *"info"*) echo "ok" ;;
  *"compose"*"pull"*) echo "pulled" ;;
  *"compose"*"up"*) echo "started" ;;
  *) echo "stub: $*" ;;
esac
STUB
  chmod +x "$HOME/bin/docker"

  # Create a fake "flight-finder-cli" download server using a local file
  mkdir -p "$HOME/fake-server"
  cp /home/testuser/flight-finder-cli "$HOME/fake-server/flight-finder-cli"
  # The CLI requires flight-finder-cli-flags.sh next to it (issue #72); ship it
  # in the fake-server so install.sh's parallel curl succeeds.
  cp /home/testuser/flight-finder-cli-flags.sh "$HOME/fake-server/flight-finder-cli-flags.sh"

  # Run installer in non-interactive mode with stubbed Docker and local CLI.
  # Pipe empty stdin so the API key prompt gets "" (skip), and FLIGHT_FINDER_YES=1
  # skips the consent prompt. The installer may fail at docker pull/up since
  # our stub is minimal, but everything up to that point should work.
  (
    export PATH="$HOME/bin:$PATH"
    export FLIGHT_FINDER_YES=1
    export FLIGHT_FINDER_URL="file://$HOME/fake-server"
    export HOST_PORT=3003

    echo "" | bash /home/testuser/install.sh 2>&1 || true
  )

  # Verify: .fairtrail directory created
  if [ -d "$HOME/.flight-finder" ]; then
    pass "E2E: ~/.flight-finder directory created"
  else
    fail "E2E: ~/.flight-finder not created" "installer didn't create directory"
  fi

  # Verify: docker-compose.yml exists
  if [ -f "$HOME/.flight-finder/docker-compose.yml" ]; then
    pass "E2E: docker-compose.yml generated"
  else
    fail "E2E: docker-compose.yml missing" "installer didn't write compose file"
  fi

  # Verify: .env generated with HOST_PORT
  if [ -f "$HOME/.flight-finder/.env" ]; then
    if grep -q 'HOST_PORT=' "$HOME/.flight-finder/.env"; then
      pass "E2E: .env contains HOST_PORT"
    else
      fail "E2E: .env missing HOST_PORT" "$(cat "$HOME/.flight-finder/.env")"
    fi
    if grep -q 'CRON_SECRET=' "$HOME/.flight-finder/.env"; then
      fail "E2E: .env should NOT contain CRON_SECRET" "entrypoint generates it at runtime"
    else
      pass "E2E: .env omits CRON_SECRET (generated at runtime by entrypoint)"
    fi
  else
    fail "E2E: .env not generated" "installer didn't write .env"
  fi

  # Verify: PATH was patched in both files
  if grep -qF '.local/bin' "$HOME/.bashrc" && grep -qF '.local/bin' "$HOME/.profile"; then
    pass "E2E: PATH patched in both .bashrc and .profile"
  else
    fail "E2E: PATH not patched in both files" "bashrc=$(grep -c .local/bin "$HOME/.bashrc") profile=$(grep -c .local/bin "$HOME/.profile")"
  fi

  # Verify: CLI binary at expected location
  if [ -f "$HOME/.local/bin/flight-finder" ] && [ -x "$HOME/.local/bin/flight-finder" ]; then
    pass "E2E: flight-finder CLI installed and executable"
  else
    fail "E2E: flight-finder CLI not found" "expected at ~/.local/bin/flight-finder"
  fi

  # Verify: fairtrail --help works via login shell.
  # The CLI needs docker compose, so put our stub docker in ~/.local/bin/ too.
  if [ -f "$HOME/.local/bin/flight-finder" ]; then
    cp "$HOME/bin/docker" "$HOME/.local/bin/docker"
    # CLI also checks for ~/.flight-finder/docker-compose.yml
    mkdir -p "$HOME/.flight-finder"
    echo "services:" > "$HOME/.flight-finder/docker-compose.yml"

    local help_output
    help_output=$(bash -l -c 'flight-finder help' 2>&1 || true)
    if echo "$help_output" | grep -q "fairtrail"; then
      pass "E2E: 'flight-finder help' works in login shell"
    else
      fail "E2E: 'flight-finder help' failed in login shell" "$help_output"
    fi
  fi

  # Cleanup
  rm -rf "$HOME/bin" "$HOME/fake-server" "$HOME/.flight-finder" "$HOME/.local"
}

# ──────────────────────────────────────────────────────────────────
# Run all
# ──────────────────────────────────────────────────────────────────
test_path_patching
test_no_duplicate_path
test_login_shell_path
test_old_dir_migration
test_cli_update_path
test_env_host_port
test_e2e_install

echo ""
printf "${BOLD}Results: ${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"
echo ""
[ "$FAIL" -eq 0 ] || exit 1
