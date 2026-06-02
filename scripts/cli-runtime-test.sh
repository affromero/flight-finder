#!/usr/bin/env bash
# Behavioral test harness for apps/web/public/flight-finder-cli.
#
# Why this exists: every previous CLI bug in this repo (issue #72 v1 — silent
# `up -d` on podman; #72 v2 — -it rejected by podman-compose; #62 — Arch
# detection; #62 — docker permission-denied vs daemon-down) shared a shape:
# shell CLI behavior that diverges by container runtime or compose flavor.
# The pre-existing install-flow-test.sh is grep-only and would pass on every
# one of those bugs. This file runs the actual CLI against shimmed compose
# binaries and asserts the recorded invocations.
#
# Coverage per command, per runtime:
#   docker_v2        docker + `docker compose` (v2 native)
#   docker_v1        docker + `docker-compose` (v1 standalone)
#   podman_native    podman + `podman compose` (v5+ native subcommand)
#   podman_delegated podman + `podman compose` wrapper delegating to the
#                    standalone podman-compose provider (Fedora default, #96)
#   podman_pc        podman + `podman-compose` (standalone Python tool)
#
# Non-TTY only (stdin redirected from /dev/null). The TTY branch of
# `cmd_tui` is covered by the helper unit test in install-flow-test.sh.

set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

PASS=0
FAIL=0
LAST_RUNTIME=""
LAST_CMD=""

pass() { PASS=$((PASS + 1)); printf "${GREEN}PASS${RESET} [%s] %s\n" "${LAST_RUNTIME}/${LAST_CMD}" "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  printf "${RED}FAIL${RESET} [%s] %s\n" "${LAST_RUNTIME}/${LAST_CMD}" "$1"
  if [ -n "${RECORD_FILE:-}" ] && [ -f "$RECORD_FILE" ]; then
    printf "${DIM}     recorded:${RESET}\n"
    sed 's/^/       /' "$RECORD_FILE"
  fi
}

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="$REPO_ROOT/apps/web/public/flight-finder-cli"
HELPER="$REPO_ROOT/apps/web/public/flight-finder-cli-flags.sh"

[ -x "$CLI" ] || { printf "${RED}missing $CLI${RESET}\n"; exit 1; }
[ -f "$HELPER" ] || { printf "${RED}missing $HELPER${RESET}\n"; exit 1; }

# ---------------------------------------------------------------------------
# Shim writers. Each test invokes setup_runtime <name> which populates
# $SANDBOX/bin with exactly the binaries that runtime should expose.
# Probes (info, compose version) return the right exit codes; everything
# else appends "<binary> <args>" to $RECORD_FILE.
# ---------------------------------------------------------------------------

# Common preamble injected into every shim. record_call <bin> <argv...>
# uses `printf '%q '` per-arg so multi-word args ("--model 'gpt 5'") are
# preserved with explicit boundaries instead of collapsing into "gpt 5".
SHIM_PREAMBLE='record_call() {
  local bin="$1"; shift
  local args_str
  if [ $# -gt 0 ]; then
    args_str=$(printf "%q " "$@")
    printf "%s %s\n" "$bin" "${args_str% }" >> "$RECORD_FILE"
  else
    printf "%s\n" "$bin" >> "$RECORD_FILE"
  fi
}'

write_docker_shim() {
  # $1: 0 if `docker compose` v2 available, 1 if not (forces docker-compose v1)
  local has_v2="$1"
  cat > "$SANDBOX/bin/docker" <<SHIM
#!/usr/bin/env bash
$SHIM_PREAMBLE
case "\$1" in
  info) exit 0 ;;
  compose)
    case "\${2:-}" in
      version) exit $has_v2 ;;
      *)
        record_call docker "\$@"
        exit $has_v2 ;;
    esac ;;
  *)
    record_call docker "\$@"
    exit 0 ;;
esac
SHIM
  chmod +x "$SANDBOX/bin/docker"
}

write_docker_compose_v1_shim() {
  cat > "$SANDBOX/bin/docker-compose" <<SHIM
#!/usr/bin/env bash
$SHIM_PREAMBLE
record_call docker-compose "\$@"
exit 0
SHIM
  chmod +x "$SANDBOX/bin/docker-compose"
}

write_podman_shim() {
  # $1: 0 if `podman compose` native subcommand available, 1 if not
  # $2: optional provider that `podman compose` delegates to (e.g.
  #     "podman-compose"). When set, `podman compose version` prints podman's
  #     external-provider banner on stderr plus a "<provider> version N" line
  #     on stdout, exactly as the real wrapper does, so the CLI can detect the
  #     delegation (#96). Empty (default) mimics a non-delegating engine.
  local has_native="$1"
  local provider="${2:-}"
  cat > "$SANDBOX/bin/podman" <<SHIM
#!/usr/bin/env bash
$SHIM_PREAMBLE
case "\$1" in
  compose)
    case "\${2:-}" in
      version)
        if [ -n "$provider" ]; then
          printf '>>>> Executing external compose provider "/usr/bin/%s". Please see %s(1) for how to disable this message. <<<<\n' "$provider" "$provider" >&2
          printf '%s version 1.0.6\n' "$provider"
        fi
        exit $has_native ;;
      *)
        record_call podman "\$@"
        exit $has_native ;;
    esac ;;
  *)
    record_call podman "\$@"
    exit 0 ;;
esac
SHIM
  chmod +x "$SANDBOX/bin/podman"
}

write_podman_compose_shim() {
  # Mirror the real argparser at podman_compose.py:4636-4683. Walk the args,
  # skipping any global -f flags before `exec`. Once we see `exec`, the only
  # tokens valid before the service name are: -d, --detach, --privileged,
  # -u/--user, -T, --index, -e/--env, -w/--workdir. Anything else (especially
  # -i, -t, -it, --interactive, --tty) must abort with the same usage error
  # the real binary produces. Without this, a buggy CLI passing -it would
  # quietly record success and the test would lie.
  cat > "$SANDBOX/bin/podman-compose" <<SHIM
#!/usr/bin/env bash
$SHIM_PREAMBLE
record_call podman-compose "\$@"
saw_exec=0
i=0
args=("\$@")
while [ \$i -lt \${#args[@]} ]; do
  a="\${args[\$i]}"
  if [ \$saw_exec -eq 0 ]; then
    case "\$a" in
      exec) saw_exec=1 ;;
      -f|--file) i=\$((i + 1)) ;;
      *) ;;
    esac
    i=\$((i + 1)); continue
  fi
  case "\$a" in
    -d|--detach|--privileged|-T) ;;
    -u|--user|--index|-e|--env|-w|--workdir) i=\$((i + 1)) ;;
    -*)
      printf 'podman-compose: error: unrecognized arguments: %s\n' "\$a" >&2
      exit 2 ;;
    *) break ;;
  esac
  i=\$((i + 1))
done
exit 0
SHIM
  chmod +x "$SANDBOX/bin/podman-compose"
}

write_curl_shim() {
  # Records each call as `curl <METHOD> <URL> [body=<BODY>]` to RECORD_FILE,
  # then responds with a body shape matching the real /api/* contract.
  # Anything not enumerated exits 0 silently (no-op).
  cat > "$SANDBOX/bin/curl" <<'SHIM'
#!/usr/bin/env bash
url=""
out=""
method="GET"
body=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -X|--request) method="$2"; shift 2 ;;
    -d|--data|--data-binary|--data-raw)
      method="POST"; body="$2"; shift 2 ;;
    -H|--header) shift 2 ;;
    --max-time|--connect-timeout|-w|--write-out|--retry|--retry-delay|--retry-max-time)
      shift 2 ;;
    -*) shift ;;
    http*|*://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -n "$body" ]; then
  printf 'curl %s %s body=%s\n' "$method" "$url" "$body" >> "$RECORD_FILE"
else
  printf 'curl %s %s\n' "$method" "$url" >> "$RECORD_FILE"
fi
case "$url" in
  *"/api/health"*)
    printf '{"activeQueries":1,"intervalHours":3,"nextScrape":"2026-05-10T12:00:00"}' ;;
  *"/api/version"*)
    printf '{"ok":true,"data":{"current":"0.5.4","commit":"3153f98abcdef"}}' ;;
  *"/api/parse"*)
    printf '{"ok":true,"data":{"confidence":"high","parsed":{"origin":"NYC","destination":"LAX","originName":"New York","destinationName":"Los Angeles","dateFrom":"2026-06-01","dateTo":"2026-06-15","origins":[{"code":"NYC"}],"destinations":[{"code":"LAX"}]}}}' ;;
  *"/api/preview"*)
    printf '{"data":{"flights":[],"routes":[]}}' ;;
  *"/api/queries"*)
    printf '{"ok":true,"data":{"queries":[{"id":"abc123"}]}}' ;;
  *"/flight-finder-cli-flags.sh"*)
    [ -n "$out" ] && printf '# stub helper\n_compose_exec_flags(){ printf %%s ""; }\n' > "$out" ;;
  *"/flight-finder-cli"*)
    [ -n "$out" ] && {
      printf '#!/usr/bin/env bash\necho stub-cli\n' > "$out"
      chmod +x "$out" 2>/dev/null || true
    } ;;
esac
exit 0
SHIM
  chmod +x "$SANDBOX/bin/curl"
}

write_python3_passthrough() {
  # Some cmd_search code paths call python3. Real python3 is fine if it's on
  # PATH outside the sandbox — symlink it through.
  if real_py=$(PATH=/usr/bin:/bin bash -c 'command -v python3' 2>/dev/null); then
    ln -sf "$real_py" "$SANDBOX/bin/python3"
  fi
}

write_browser_stubs() {
  # cmd_search/cmd_start_* call `open` (macOS) or `xdg-open` (Linux) on
  # success. Without stubs, every test run pops a real browser tab on the
  # developer's machine. Record but don't actually open anything.
  cat > "$SANDBOX/bin/open" <<'SHIM'
#!/usr/bin/env bash
printf 'open %s\n' "$*" >> "$RECORD_FILE"
SHIM
  cat > "$SANDBOX/bin/xdg-open" <<'SHIM'
#!/usr/bin/env bash
printf 'xdg-open %s\n' "$*" >> "$RECORD_FILE"
SHIM
  chmod +x "$SANDBOX/bin/open" "$SANDBOX/bin/xdg-open"
}

# ---------------------------------------------------------------------------
# Sandbox / runtime setup
# ---------------------------------------------------------------------------

setup_sandbox() {
  SANDBOX=$(mktemp -d -t flight-finder-cli-test-XXXXXX)
  mkdir -p "$SANDBOX/bin" "$SANDBOX/sysbin" "$SANDBOX/.flight-finder"
  cat > "$SANDBOX/.flight-finder/docker-compose.yml" <<'YAML'
services:
  web:
    image: ghcr.io/affromero/flight-finder:latest
YAML
  RECORD_FILE="$SANDBOX/record.log"
  : > "$RECORD_FILE"
  export RECORD_FILE

  # Curated sysbin: symlinks only to the system tools the CLI actually uses.
  # Hermetic so `command -v docker` cannot find /usr/bin/docker on Ubuntu CI
  # (where it would otherwise short-circuit every podman_* test).
  local tool real
  for tool in bash sh env mktemp \
              printf echo cat sed grep head tail cut tr sort uniq awk \
              mkdir rmdir rm cp mv ln chmod basename dirname \
              date sleep uname id whoami tput tee pwd ls find \
              xargs which true false stat touch \
              python3 git ; do
    real=""
    for d in /usr/bin /bin /usr/local/bin; do
      if [ -x "$d/$tool" ]; then real="$d/$tool"; break; fi
    done
    [ -n "$real" ] && ln -sf "$real" "$SANDBOX/sysbin/$tool"
  done
}

teardown_sandbox() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  SANDBOX=""
  RECORD_FILE=""
}

setup_runtime() {
  LAST_RUNTIME="$1"
  rm -f "$SANDBOX"/bin/docker "$SANDBOX"/bin/docker-compose \
        "$SANDBOX"/bin/podman "$SANDBOX"/bin/podman-compose
  case "$1" in
    docker_v2)
      write_docker_shim 0 ;;
    docker_v1)
      write_docker_shim 1
      write_docker_compose_v1_shim ;;
    podman_native)
      write_podman_shim 0 ;;
    podman_delegated)
      # `podman compose` exists (exit 0) but delegates to the standalone
      # podman-compose provider, which rejects -it/-i. The CLI must detect the
      # delegation and collapse to the podman-compose path with -T flags (#96).
      write_podman_shim 0 podman-compose
      write_podman_compose_shim ;;
    podman_pc)
      write_podman_shim 1
      write_podman_compose_shim ;;
    *) printf "${RED}unknown runtime: $1${RESET}\n"; exit 1 ;;
  esac
  write_curl_shim
  write_python3_passthrough
  write_browser_stubs
}

# Run the CLI under the sandbox. stdin is a single newline (not /dev/null)
# so that interactive `read -rp` prompts (cmd_stop, cmd_uninstall) get an
# empty answer and take the cancel path, not crash from EOF under set -e.
# To answer "y", use run_cli_with_input "y\n" <cmd>.
# Captures exit code into LAST_EXIT for assertions; default expectation is
# 0 unless the test sets EXPECT_NONZERO=1 before calling.
LAST_EXIT=0
run_cli() {
  LAST_CMD="$1"
  shift
  : > "$RECORD_FILE"
  set +e
  printf '\n' \
    | HOME="$SANDBOX" \
      PATH="$SANDBOX/bin:$SANDBOX/sysbin" \
      RECORD_FILE="$RECORD_FILE" \
      FLIGHT_FINDER_URL="http://test.invalid" \
      HOST_PORT=3003 \
      bash "$CLI" "$LAST_CMD" "$@" >/dev/null 2>&1
  LAST_EXIT=$?
  set -e
  if [ "${EXPECT_NONZERO:-0}" != "1" ] && [ $LAST_EXIT -ne 0 ]; then
    fail "CLI exited $LAST_EXIT — assertions on its recorded calls are unreliable"
  fi
}

# Same as run_cli, but pipes a string into stdin so confirm prompts get
# answered. Use for stop/uninstall confirm=Y tests.
run_cli_with_input() {
  local input="$1"
  LAST_CMD="$2"
  shift 2
  : > "$RECORD_FILE"
  set +e
  printf '%s' "$input" \
    | HOME="$SANDBOX" \
      PATH="$SANDBOX/bin:$SANDBOX/sysbin" \
      RECORD_FILE="$RECORD_FILE" \
      FLIGHT_FINDER_URL="http://test.invalid" \
      HOST_PORT=3003 \
      bash "$CLI" "$LAST_CMD" "$@" >/dev/null 2>&1
  LAST_EXIT=$?
  set -e
  if [ "${EXPECT_NONZERO:-0}" != "1" ] && [ $LAST_EXIT -ne 0 ]; then
    fail "CLI exited $LAST_EXIT — assertions on its recorded calls are unreliable"
  fi
}

# Match a regex against the recorded invocations (one per line).
assert_recorded() {
  local label="$1" pattern="$2"
  if grep -qE "$pattern" "$RECORD_FILE"; then
    pass "$label"
  else
    fail "$label — no line matched: $pattern"
  fi
}

# Inverse: assert no recorded line matches.
assert_not_recorded() {
  local label="$1" pattern="$2"
  if ! grep -qE "$pattern" "$RECORD_FILE"; then
    pass "$label"
  else
    fail "$label — unexpected line matched: $pattern"
  fi
}

# ---------------------------------------------------------------------------
# Test cases — cmd_tui (the bug we shipped a fix for)
# ---------------------------------------------------------------------------

test_tui_headless_docker_v2() {
  setup_runtime docker_v2
  run_cli --headless
  assert_recorded "tui sends docker compose exec -i web flight-finder-tui --headless" \
    'docker compose -f docker-compose.yml exec -i web flight-finder-tui --headless'
}

test_tui_headless_docker_v1() {
  setup_runtime docker_v1
  run_cli --headless
  assert_recorded "tui sends docker-compose exec -i web flight-finder-tui --headless" \
    'docker-compose -f docker-compose.yml exec -i web flight-finder-tui --headless'
}

test_tui_headless_podman_native() {
  setup_runtime podman_native
  run_cli --headless
  assert_recorded "tui sends podman compose exec -i web flight-finder-tui --headless" \
    'podman compose -f docker-compose.yml exec -i web flight-finder-tui --headless'
}

test_tui_headless_podman_pc() {
  # The bug from issue #72 — must NOT pass -i or -it; podman-compose only
  # accepts -T to disable TTY.
  setup_runtime podman_pc
  run_cli --headless
  assert_recorded "tui sends podman-compose exec -T web flight-finder-tui --headless (#72)" \
    'podman-compose -f docker-compose.yml exec -T web flight-finder-tui --headless'
  assert_not_recorded "tui never sends -it/-i to podman-compose (#72)" \
    'podman-compose .* exec [^ ]*(-it|-i ) '
}

test_tui_list_podman_pc() {
  setup_runtime podman_pc
  run_cli --list
  assert_recorded "tui --list sends podman-compose exec -T web flight-finder-tui --list" \
    'podman-compose -f docker-compose.yml exec -T web flight-finder-tui --list'
}

test_tui_headless_podman_delegated() {
  # #96: `podman compose version` succeeds, but the wrapper delegates to the
  # external podman-compose provider, which rejects -it/-i. The CLI must detect
  # the delegation and route exec through podman-compose with -T — never
  # `podman compose ... -i`.
  setup_runtime podman_delegated
  run_cli --headless
  assert_recorded "delegated podman compose routes exec through podman-compose -T (#96)" \
    '^podman-compose -f docker-compose.yml exec -T web flight-finder-tui --headless$'
  assert_not_recorded "delegated podman never sends -it/-i (#96)" \
    'podman-compose .* exec [^ ]*(-it|-i ) '
  assert_not_recorded "delegated podman does not exec through the podman compose wrapper (#96)" \
    '^podman compose -f docker-compose.yml exec'
}

test_tui_list_podman_delegated() {
  setup_runtime podman_delegated
  run_cli --list
  assert_recorded "delegated podman compose --list routes through podman-compose -T (#96)" \
    '^podman-compose -f docker-compose.yml exec -T web flight-finder-tui --list$'
}

# Codex audit gap 10: argv boundaries must survive recording so a
# multi-word arg ("--model 'gpt 5 turbo'") is distinguishable from three
# separate words. The shims use printf %q per arg, which backslash-
# escapes spaces in multi-word tokens.
test_tui_preserves_multi_word_arg_boundaries() {
  setup_runtime podman_pc
  run_cli --headless --model "gpt 5 turbo"
  LAST_RUNTIME="podman_pc"; LAST_CMD="--headless"
  # The %q quoting renders 'gpt 5 turbo' as gpt\ 5\ turbo. The pattern
  # below matches the escaped form on the same line as flight-finder-tui.
  assert_recorded "multi-word --model arg recorded with boundaries intact (#72)" \
    'flight-finder-tui --headless --model gpt\\ 5\\ turbo'
  # Negative control: the unsplit form 'gpt 5 turbo' (three plain tokens)
  # must NOT appear, otherwise we would not be able to tell argv-3 from
  # argv-1-with-spaces.
  assert_not_recorded "multi-word arg is not recorded as three plain tokens" \
    'flight-finder-tui --headless --model gpt 5 turbo$'
}

# ---------------------------------------------------------------------------
# Test cases — cmd_update (issue #72 v1)
# ---------------------------------------------------------------------------

test_update_pulls_then_force_recreates_web() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli update
    LAST_RUNTIME="$rt"; LAST_CMD="update"
    assert_recorded "update pulls web" \
      ' pull web'
    assert_recorded "update brings up db/redis with --no-recreate" \
      ' up -d --no-recreate db redis'
    assert_recorded "update force-recreates web (#72 v1)" \
      ' up -d --force-recreate --no-deps --remove-orphans web'
  done
}

# ---------------------------------------------------------------------------
# Test cases — cmd_start_background, cmd_stop, cmd_logs, cmd_status
# ---------------------------------------------------------------------------

test_start_calls_up_dash_d() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli start
    LAST_RUNTIME="$rt"; LAST_CMD="start"
    assert_recorded "start runs dc up -d" ' up -d( |$)'
  done
}

test_logs_calls_dc_logs_f_web() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli logs
    LAST_RUNTIME="$rt"; LAST_CMD="logs"
    case "$rt" in
      docker_v2)     assert_recorded "logs -> docker compose logs -f web"   '^docker compose -f docker-compose.yml logs -f web$' ;;
      docker_v1)     assert_recorded "logs -> docker-compose logs -f web"   '^docker-compose -f docker-compose.yml logs -f web$' ;;
      podman_native) assert_recorded "logs -> podman compose logs -f web"   '^podman compose -f docker-compose.yml logs -f web$' ;;
      podman_delegated) assert_recorded "logs -> podman-compose logs -f web (delegated #96)" '^podman-compose -f docker-compose.yml logs -f web$' ;;
      podman_pc)     assert_recorded "logs -> podman-compose logs -f web"   '^podman-compose -f docker-compose.yml logs -f web$' ;;
    esac
  done
}

test_no_arg_runs_full_foreground_pipeline() {
  # Bare `fairtrail` triggers cmd_start_foreground:
  #   dc up -d -> poll /api/health -> dc logs -f web (shim returns 0).
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli ""
    LAST_RUNTIME="$rt"; LAST_CMD="(no-arg)"
    assert_recorded "no-arg runs dc up -d before logs"  ' up -d( |$)'
    assert_recorded "no-arg polls /api/health" \
      '^curl GET http://localhost:3003/api/health$'
    case "$rt" in
      docker_v2)     assert_recorded "no-arg tails docker compose logs -f web"   '^docker compose -f docker-compose.yml logs -f web$' ;;
      docker_v1)     assert_recorded "no-arg tails docker-compose logs -f web"   '^docker-compose -f docker-compose.yml logs -f web$' ;;
      podman_native) assert_recorded "no-arg tails podman compose logs -f web"   '^podman compose -f docker-compose.yml logs -f web$' ;;
      podman_delegated) assert_recorded "no-arg tails podman-compose logs -f web (delegated #96)" '^podman-compose -f docker-compose.yml logs -f web$' ;;
      podman_pc)     assert_recorded "no-arg tails podman-compose logs -f web"   '^podman-compose -f docker-compose.yml logs -f web$' ;;
    esac
  done
}

test_stop_aborts_without_confirmation() {
  # Empty answer (just hitting Enter) → cancel branch. dc stop must NOT run.
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli stop
    LAST_RUNTIME="$rt"; LAST_CMD="stop"
    assert_not_recorded "stop respects empty answer (no dc stop on cancel)" \
      ' stop( |$)'
  done
}

test_stop_invokes_compose_on_y() {
  # Answer "y" → dc stop must run with the runtime-correct prefix.
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli_with_input $'y\n' stop
    LAST_RUNTIME="$rt"; LAST_CMD="stop"
    case "$rt" in
      docker_v2)     assert_recorded "stop -> docker compose stop"   '^docker compose -f docker-compose.yml stop$' ;;
      docker_v1)     assert_recorded "stop -> docker-compose stop"   '^docker-compose -f docker-compose.yml stop$' ;;
      podman_native) assert_recorded "stop -> podman compose stop"   '^podman compose -f docker-compose.yml stop$' ;;
      podman_delegated) assert_recorded "stop -> podman-compose stop (delegated #96)" '^podman-compose -f docker-compose.yml stop$' ;;
      podman_pc)     assert_recorded "stop -> podman-compose stop"   '^podman-compose -f docker-compose.yml stop$' ;;
    esac
  done
}

test_uninstall_aborts_without_confirmation() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli uninstall
    LAST_RUNTIME="$rt"; LAST_CMD="uninstall"
    assert_not_recorded "uninstall respects empty answer (no dc down on cancel)" \
      ' down -v( |$)'
    [ -d "$SANDBOX/.flight-finder" ] \
      && pass "uninstall did not remove ~/.flight-finder on cancel" \
      || fail "uninstall removed ~/.flight-finder despite cancel"
  done
}

test_uninstall_invokes_compose_and_removes_dir_on_y() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli_with_input $'y\n' uninstall
    LAST_RUNTIME="$rt"; LAST_CMD="uninstall"
    case "$rt" in
      docker_v2)     assert_recorded "uninstall -> docker compose down -v"   '^docker compose -f docker-compose.yml down -v$' ;;
      docker_v1)     assert_recorded "uninstall -> docker-compose down -v"   '^docker-compose -f docker-compose.yml down -v$' ;;
      podman_native) assert_recorded "uninstall -> podman compose down -v"   '^podman compose -f docker-compose.yml down -v$' ;;
      podman_delegated) assert_recorded "uninstall -> podman-compose down -v (delegated #96)" '^podman-compose -f docker-compose.yml down -v$' ;;
      podman_pc)     assert_recorded "uninstall -> podman-compose down -v"   '^podman-compose -f docker-compose.yml down -v$' ;;
    esac
    if [ ! -d "$SANDBOX/.flight-finder" ]; then
      pass "uninstall removed ~/.flight-finder on confirm=y"
    else
      fail "uninstall did not remove ~/.flight-finder on confirm=y"
    fi
    # Recreate sandbox state so subsequent tests still find docker-compose.yml.
    mkdir -p "$SANDBOX/.flight-finder"
    cat > "$SANDBOX/.flight-finder/docker-compose.yml" <<'YAML'
services:
  web:
    image: ghcr.io/affromero/flight-finder:latest
YAML
  done
}

# ---------------------------------------------------------------------------
# Test cases — cmd_search (POSTs to /api/parse, /api/preview, /api/queries)
# ---------------------------------------------------------------------------

test_search_hits_all_three_endpoints() {
  # cmd_search must POST query→/api/parse, then POST parsed→/api/preview,
  # then POST tracker body→/api/queries. Runtime-independent (no compose).
  for rt in docker_v2 podman_pc; do
    setup_runtime "$rt"
    run_cli search "NYC to LAX next month"
    LAST_RUNTIME="$rt"; LAST_CMD="search"
    assert_recorded "search POSTs /api/parse with query body" \
      '^curl POST http://localhost:3003/api/parse body=\{.*"query":[[:space:]]*"NYC to LAX next month".*\}$'
    assert_recorded "search POSTs /api/preview with parsed origin/destination" \
      '^curl POST http://localhost:3003/api/preview body=\{.*"origin":[[:space:]]*"NYC".*"destination":[[:space:]]*"LAX".*\}$'
    assert_recorded "search POSTs /api/queries with rawInput tracker body" \
      '^curl POST http://localhost:3003/api/queries body=\{.*"rawInput":[[:space:]]*"NYC to LAX next month".*\}$'
    assert_not_recorded "search never invokes compose" \
      '\b(up|down|stop|exec|pull|logs) '
  done
}

test_search_aborts_when_health_fails() {
  # If /api/health returns nothing, cmd_search must NOT proceed to /api/parse.
  setup_runtime docker_v2
  # Replace curl shim with one that returns empty for /api/health.
  cat > "$SANDBOX/bin/curl" <<'SHIM'
#!/usr/bin/env bash
url=""; for arg in "$@"; do case "$arg" in http*) url="$arg" ;; esac; done
printf 'curl GET %s\n' "$url" >> "$RECORD_FILE"
exit 0
SHIM
  chmod +x "$SANDBOX/bin/curl"
  EXPECT_NONZERO=1 run_cli search "NYC to LAX"
  unset EXPECT_NONZERO
  LAST_RUNTIME="docker_v2"; LAST_CMD="search"
  if [ "$LAST_EXIT" -ne 0 ]; then
    pass "search exits non-zero when /api/health is unreachable"
  else
    fail "search should exit non-zero when /api/health is unreachable"
  fi
  assert_not_recorded "search does not POST /api/parse when health fails" \
    '/api/parse'
}

test_status_only_calls_curl() {
  # status should not invoke compose at all — pure /api/health probe.
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli status
    LAST_RUNTIME="$rt"; LAST_CMD="status"
    assert_not_recorded "status never invokes compose" '\b(up|down|stop|exec|pull) '
  done
}

test_version_only_calls_curl() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli version
    LAST_RUNTIME="$rt"; LAST_CMD="version"
    assert_not_recorded "version never invokes compose" '\b(up|down|stop|exec|pull) '
  done
}

# ---------------------------------------------------------------------------
# Test cases — compose file composition (override + VPN auto-inclusion)
# ---------------------------------------------------------------------------

test_compose_files_includes_override_when_present() {
  setup_runtime docker_v2
  echo "services: { web: { environment: { FOO: bar } } }" \
    > "$SANDBOX/.flight-finder/docker-compose.override.yml"
  run_cli start
  LAST_RUNTIME="docker_v2"; LAST_CMD="start"
  assert_recorded "override file appended to -f chain" \
    '^docker compose -f docker-compose.yml -f docker-compose.override.yml up -d'
  rm -f "$SANDBOX/.flight-finder/docker-compose.override.yml"
}

test_vpn_compose_excluded_without_env() {
  # No .env file at all → VPN sidecar must NOT be included.
  setup_runtime docker_v2
  echo "services: { vpn: {} }" > "$SANDBOX/.flight-finder/docker-compose.vpn.yml"
  rm -f "$SANDBOX/.flight-finder/.env"
  run_cli start
  LAST_RUNTIME="docker_v2"; LAST_CMD="start"
  assert_not_recorded "no .env -> VPN sidecar omitted" 'docker-compose.vpn.yml'
  rm -f "$SANDBOX/.flight-finder/docker-compose.vpn.yml"
}

test_vpn_compose_excluded_when_commented() {
  # .env has the token only inside a comment → must be treated as disabled.
  # This is the actual bug Codex audit found: `grep -q "EXPRESSVPN_CODE"`
  # used to match commented lines and enable the VPN sidecar.
  setup_runtime docker_v2
  echo "services: { vpn: {} }" > "$SANDBOX/.flight-finder/docker-compose.vpn.yml"
  printf '# EXPRESSVPN_CODE=placeholder\nDB_URL=postgres://x\n' \
    > "$SANDBOX/.flight-finder/.env"
  run_cli start
  LAST_RUNTIME="docker_v2"; LAST_CMD="start"
  assert_not_recorded "commented EXPRESSVPN_CODE -> VPN sidecar omitted" \
    'docker-compose.vpn.yml'
  rm -f "$SANDBOX/.flight-finder/docker-compose.vpn.yml" "$SANDBOX/.flight-finder/.env"
}

test_vpn_compose_excluded_when_empty_value() {
  # EXPRESSVPN_CODE= (no value) is also disabled.
  setup_runtime docker_v2
  echo "services: { vpn: {} }" > "$SANDBOX/.flight-finder/docker-compose.vpn.yml"
  printf 'EXPRESSVPN_CODE=\n' > "$SANDBOX/.flight-finder/.env"
  run_cli start
  LAST_RUNTIME="docker_v2"; LAST_CMD="start"
  assert_not_recorded "empty EXPRESSVPN_CODE -> VPN sidecar omitted" \
    'docker-compose.vpn.yml'
  rm -f "$SANDBOX/.flight-finder/docker-compose.vpn.yml" "$SANDBOX/.flight-finder/.env"
}

test_vpn_compose_included_when_enabled() {
  setup_runtime docker_v2
  echo "services: { vpn: {} }" > "$SANDBOX/.flight-finder/docker-compose.vpn.yml"
  printf 'EXPRESSVPN_CODE=ABC123XYZ\n' > "$SANDBOX/.flight-finder/.env"
  run_cli start
  LAST_RUNTIME="docker_v2"; LAST_CMD="start"
  assert_recorded "EXPRESSVPN_CODE=value -> VPN sidecar appended" \
    '^docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d'
  rm -f "$SANDBOX/.flight-finder/docker-compose.vpn.yml" "$SANDBOX/.flight-finder/.env"
}

# ---------------------------------------------------------------------------
# Helper missing → CLI must exit non-zero (loud failure)
# ---------------------------------------------------------------------------

test_missing_helper_fails_loudly() {
  setup_runtime docker_v2
  LAST_RUNTIME="missing-helper"; LAST_CMD="--headless"
  # Run a copy of the CLI without the helper next to it.
  local cli_copy="$SANDBOX/bin/flight-finder-orphan"
  cp "$CLI" "$cli_copy"
  # No helper sibling — should fail with non-zero and print to stderr.
  local exit_code stderr_out
  set +e
  stderr_out=$(HOME="$SANDBOX" PATH="$SANDBOX/bin:$SANDBOX/sysbin" \
    bash "$cli_copy" --headless </dev/null 2>&1 >/dev/null)
  exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ] && echo "$stderr_out" | grep -q "flight-finder-cli-flags.sh"; then
    pass "CLI exits non-zero with helpful message when helper is missing"
  else
    fail "CLI must exit non-zero and mention flight-finder-cli-flags.sh — got exit=$exit_code, stderr=$stderr_out"
  fi
}

# Negative-control: a CLI that crashes during dispatch must NOT silently
# pass tests like "status never invokes compose". Rewrite the CLI's
# `status` dispatcher to exit 7, run via run_cli with EXPECT_NONZERO=1 to
# bypass fail(), and assert LAST_EXIT was captured.
test_run_cli_captures_exit() {
  setup_runtime docker_v2
  LAST_RUNTIME="harness"; LAST_CMD="self-check"
  local crashy_cli="$SANDBOX/bin/flight-finder-crashy"
  sed 's#status)    cmd_status ;;#status)    exit 7 ;;#' "$CLI" > "$crashy_cli"
  chmod +x "$crashy_cli"
  # The helper must sit next to the CLI for the source guard to pass.
  cp "$HELPER" "$SANDBOX/bin/flight-finder-cli-flags.sh"
  local prev_cli="$CLI"
  CLI="$crashy_cli"
  EXPECT_NONZERO=1 run_cli status
  CLI="$prev_cli"
  unset EXPECT_NONZERO
  if [ "$LAST_EXIT" = "7" ]; then
    pass "run_cli captures CLI exit code (LAST_EXIT=7)"
  else
    fail "run_cli should capture exit code 7, got $LAST_EXIT"
  fi
}

# ---------------------------------------------------------------------------
# Test cases — cmd_reset_password / cmd_disable_accounts (issue #102)
# ---------------------------------------------------------------------------

test_reset_password_execs_with_credentials() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli reset-password garry secretpass123
    LAST_RUNTIME="$rt"; LAST_CMD="reset-password"
    case "$rt" in
      docker_v2)        assert_recorded "reset-password -> docker compose exec -i web --reset-password garry --new-password" \
        '^docker compose -f docker-compose.yml exec -i web flight-finder-tui --reset-password garry --new-password secretpass123$' ;;
      docker_v1)        assert_recorded "reset-password -> docker-compose exec -i web --reset-password garry --new-password" \
        '^docker-compose -f docker-compose.yml exec -i web flight-finder-tui --reset-password garry --new-password secretpass123$' ;;
      podman_native)    assert_recorded "reset-password -> podman compose exec -i web --reset-password garry --new-password" \
        '^podman compose -f docker-compose.yml exec -i web flight-finder-tui --reset-password garry --new-password secretpass123$' ;;
      podman_delegated) assert_recorded "reset-password -> podman-compose exec -T web (delegated #96)" \
        '^podman-compose -f docker-compose.yml exec -T web flight-finder-tui --reset-password garry --new-password secretpass123$' ;;
      podman_pc)        assert_recorded "reset-password -> podman-compose exec -T web (#72)" \
        '^podman-compose -f docker-compose.yml exec -T web flight-finder-tui --reset-password garry --new-password secretpass123$' ;;
    esac
    assert_not_recorded "reset-password never sends -it/-i to podman-compose" \
      'podman-compose .* exec [^ ]*(-it|-i ) '
  done
}

test_reset_password_requires_both_args() {
  # Missing password must abort before any container exec.
  setup_runtime docker_v2
  EXPECT_NONZERO=1 run_cli reset-password garry
  unset EXPECT_NONZERO
  assert_not_recorded "reset-password with no password never execs the container" \
    'exec .* web flight-finder-tui --reset-password'
}

test_disable_accounts_execs() {
  for rt in docker_v2 docker_v1 podman_native podman_delegated podman_pc; do
    setup_runtime "$rt"
    run_cli disable-accounts
    LAST_RUNTIME="$rt"; LAST_CMD="disable-accounts"
    case "$rt" in
      docker_v2)        assert_recorded "disable-accounts -> docker compose exec -i web --disable-accounts" \
        '^docker compose -f docker-compose.yml exec -i web flight-finder-tui --disable-accounts$' ;;
      docker_v1)        assert_recorded "disable-accounts -> docker-compose exec -i web --disable-accounts" \
        '^docker-compose -f docker-compose.yml exec -i web flight-finder-tui --disable-accounts$' ;;
      podman_native)    assert_recorded "disable-accounts -> podman compose exec -i web --disable-accounts" \
        '^podman compose -f docker-compose.yml exec -i web flight-finder-tui --disable-accounts$' ;;
      podman_delegated) assert_recorded "disable-accounts -> podman-compose exec -T web (delegated #96)" \
        '^podman-compose -f docker-compose.yml exec -T web flight-finder-tui --disable-accounts$' ;;
      podman_pc)        assert_recorded "disable-accounts -> podman-compose exec -T web (#72)" \
        '^podman-compose -f docker-compose.yml exec -T web flight-finder-tui --disable-accounts$' ;;
    esac
    assert_not_recorded "disable-accounts never sends -it/-i to podman-compose" \
      'podman-compose .* exec [^ ]*(-it|-i ) '
  done
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
echo ""
printf "${BOLD}Fairtrail CLI behavioral tests (runtime matrix)${RESET}\n"
echo ""

trap 'teardown_sandbox' EXIT
setup_sandbox

test_tui_headless_docker_v2
test_tui_headless_docker_v1
test_tui_headless_podman_native
test_tui_headless_podman_pc
test_tui_list_podman_pc
test_tui_headless_podman_delegated
test_tui_list_podman_delegated
test_tui_preserves_multi_word_arg_boundaries
test_update_pulls_then_force_recreates_web
test_start_calls_up_dash_d
test_logs_calls_dc_logs_f_web
test_no_arg_runs_full_foreground_pipeline
test_stop_aborts_without_confirmation
test_stop_invokes_compose_on_y
test_uninstall_aborts_without_confirmation
test_uninstall_invokes_compose_and_removes_dir_on_y
test_search_hits_all_three_endpoints
test_search_aborts_when_health_fails
test_status_only_calls_curl
test_version_only_calls_curl
test_compose_files_includes_override_when_present
test_vpn_compose_excluded_without_env
test_vpn_compose_excluded_when_commented
test_vpn_compose_excluded_when_empty_value
test_vpn_compose_included_when_enabled
test_missing_helper_fails_loudly
test_run_cli_captures_exit
test_reset_password_execs_with_credentials
test_reset_password_requires_both_args
test_disable_accounts_execs

echo ""
printf "${BOLD}Results: ${GREEN}%d passed${RESET}, ${RED}%d failed${RESET}\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
