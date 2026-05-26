# shellcheck shell=bash
# Compose-flavor flag helpers, sourced by flight-finder-cli and the test suite.
#
# Why this file is separate: the four compose flavors flight-finder-cli detects
# (`docker compose`, `docker-compose`, `podman compose`, `podman-compose`)
# do NOT share a flag surface for `exec`. Specifically, `podman-compose`
# (the standalone Python tool from containers/podman-compose) accepts only
# `-T` to disable TTY allocation — `-i`, `-t`, and `-it` raise
# "unrecognized arguments" and abort the command (issue #72 follow-up,
# verified against podman_compose.py:4636-4683).
#
# The other three flavors (docker compose v2, docker-compose v1,
# podman compose native v5+) implement Docker's flag surface, so `-it`/`-i`
# work as expected.
#
# Branch on `$_DC` (the resolved compose invocation string), not on
# `$CONTAINER_CMD` — `podman compose` and `podman-compose` share
# CONTAINER_CMD=podman but require different flags.

# _compose_exec_flags <dc> <stdin_tty> <stdout_tty>
#
# <dc>          Exact `$_DC` string: "docker compose" | "docker-compose"
#               | "podman compose" | "podman-compose".
# <stdin_tty>   "1" if caller's stdin is a TTY, "0" otherwise.
# <stdout_tty>  "1" if caller's stdout is a TTY, "0" otherwise.
#
# Prints the flag(s) that should appear between `exec` and the service name
# in `$_DC $COMPOSE_FILES exec <flags> <service> <command>`. May print an
# empty string — the caller MUST leave `$exec_flags` unquoted at the call
# site so word-splitting collapses it to nothing.
_compose_exec_flags() {
  local dc="$1" stdin_tty="${2:-0}" stdout_tty="${3:-0}" interactive=0
  if [ "$stdin_tty" = "1" ] && [ "$stdout_tty" = "1" ]; then
    interactive=1
  fi
  case "$dc" in
    "podman-compose")
      # Standalone podman-compose: --interactive is implicit (always passed
      # to `podman exec`); a TTY is allocated by default. -T disables the
      # TTY when stdin/stdout are not terminals. -i / -it are rejected.
      if [ "$interactive" = "1" ]; then
        printf ''
      else
        printf '%s' '-T'
      fi
      ;;
    "docker compose"|"docker-compose"|"podman compose")
      # Docker-compatible flag surface: docker compose v2 native,
      # docker-compose v1 standalone, podman compose v5+ native subcommand.
      if [ "$interactive" = "1" ]; then
        printf '%s' '-it'
      else
        printf '%s' '-i'
      fi
      ;;
    *)
      # Hard-fail on unknown compose flavors (nerdctl, finch, lima
      # nerdctl wrappers, etc.). Falling through to docker-compatible
      # would silently assume the new tool accepts -i/-it — exactly the
      # mistake that produced issue #72. Anyone wiring up a new flavor
      # MUST add an explicit case here and a test in cli-runtime-test.sh.
      printf '_compose_exec_flags: unsupported compose flavor "%s" — add explicit support in flight-finder-cli-flags.sh\n' "$dc" >&2
      return 2
      ;;
  esac
}
