#!/bin/sh
set -e

echo "============================================"
echo "  Flight Finder — Flight Price Tracker"
echo "============================================"

# --- App mode + CLI provider install flags ---
# This image IS the self-hosted distribution, so the app defaults to self-hosted.
# flight-finder.org is the only deployment that opts into hosted mode, and it does
# so by setting SELF_HOSTED=false explicitly in its compose. Exporting here (rather
# than only defaulting inline) is what makes the Next.js server process see the same
# value the entrypoint assumes. Without it, a compose that omits the var leaves the
# app in hosted mode and per-tracker edit controls hide on token-less browsers.
export SELF_HOSTED="${SELF_HOSTED:-true}"
# CLI provider install (Claude Code / Codex) is independent of app mode: the hosted
# production box runs hosted yet still installs the CLIs for the Claude Code provider.
# Fast hosted test stacks set this to false to skip the ~15s install.
export INSTALL_CLI_PROVIDERS="${INSTALL_CLI_PROVIDERS:-true}"
if [ "$SELF_HOSTED" = "true" ]; then
  echo "[setup] App mode: self-hosted (SELF_HOSTED=true, INSTALL_CLI_PROVIDERS=$INSTALL_CLI_PROVIDERS)"
else
  echo "[setup] App mode: hosted (SELF_HOSTED=false, INSTALL_CLI_PROVIDERS=$INSTALL_CLI_PROVIDERS)"
fi

# --- Auto-generate secrets if not set ---
generate_secret() {
  # 32 random bytes → 64-char hex string
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

if [ -z "$ADMIN_SESSION_SECRET" ]; then
  export ADMIN_SESSION_SECRET
  ADMIN_SESSION_SECRET=$(generate_secret)
  echo "[setup] Generated ADMIN_SESSION_SECRET (set it in .env to persist across restarts)"
fi

if [ "$SELF_HOSTED" = "true" ] && [ -z "$CRON_SECRET" ]; then
  export CRON_SECRET
  CRON_SECRET=$(generate_secret)
  echo "[setup] Generated CRON_SECRET (set it in .env to persist across restarts)"
fi

# --- Wait for database ---
echo "[setup] Waiting for database..."
RETRIES=30
until node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => c.query('SELECT 1')).then(() => c.end()).then(() => process.exit(0))
    .catch(() => { try { c.end(); } catch (_e) {} process.exit(1); });
" 2>/dev/null; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "[setup] ERROR: Could not connect to database after 30 attempts"
    exit 1
  fi
  sleep 1
done
echo "[setup] Database is ready"

echo "[setup] Preparing shared platform state..."
node /app/packages/cli/dist/index.js access prepare

# --- Run migrations ---
# Use the Prisma CLI bundled into the image (see the prismacli stage in the
# Dockerfile) instead of fetching it with npx at runtime, which round-trips the
# registry and failed when it could not resolve the CLI. Run it directly and
# honor the exit code so a failed push halts startup instead of masking the
# error behind a misleading "Schema ready".
#
# Prisma 7 notes: --skip-generate is gone (db push no longer generates), and the
# schema's datasource has no url, so we pass it with --url. We deliberately do
# NOT ship prisma.config.ts to the runtime image: loading it needs `prisma` on
# the runtime node_modules (it is a devDependency, omitted from the lean image),
# so the entrypoint drives the CLI with explicit --schema/--url flags instead.
echo "[setup] Applying database schema..."
if node /app/prisma-cli/node_modules/prisma/build/index.js db push \
     --accept-data-loss --schema=apps/web/prisma/schema.prisma --url="$DATABASE_URL"; then
  echo "[setup] Schema ready"
else
  echo "[setup] ERROR: database schema push failed" >&2
  exit 1
fi

# Relational job invariants and partial indexes are not represented by Prisma.
node /app/scripts/apply-travel-constraints.mjs

echo "[setup] Verifying shared platform state..."
node /app/packages/cli/dist/index.js access finalize

if [ "${SIDEDOOR_PREPARE_ONLY:-false}" = "true" ]; then
  access_listing="$(node /app/packages/cli/dist/index.js access list)"
  printf '%s\n' "$access_listing"
  if ! printf '%s\n' "$access_listing" | grep -q '"role": "owner"'; then
    node /app/packages/cli/dist/index.js access claim
  fi
  exit 0
fi

# --- CLI provider auth + install (Claude Code / Codex) ---
# Gated on INSTALL_CLI_PROVIDERS (default true), independent of app mode: the hosted
# production box installs the CLIs for the Claude Code provider, while fast hosted
# test stacks set INSTALL_CLI_PROVIDERS=false to skip the ~15s install.
if [ "$INSTALL_CLI_PROVIDERS" = "true" ]; then
  # Copy CLI auth from read-only host mounts into writable directories.
  # The installer mounts host ~/.claude and ~/.codex as read-only at *-host paths.
  # CLIs need write access (models cache, sessions), so we copy into writable dirs.
  # The host mount is read-only, so it never receives a rotation. Preserve the
  # credential the CLI rotated before letting the overlay run, then keep
  # whichever generation is newer: restoring the host's retired token would lock
  # this container out of its own subscription until someone pastes new ones.
  rotated_claude=""
  if [ -f /home/node/.claude/.credentials.json ]; then
    rotated_claude="$(mktemp)"
    cp /home/node/.claude/.credentials.json "$rotated_claude" 2>/dev/null || rotated_claude=""
  fi
  if [ -d /home/node/.claude-host ] && [ "$(ls -A /home/node/.claude-host 2>/dev/null)" ]; then
    if cp -r /home/node/.claude-host/. /home/node/.claude/ 2>/dev/null; then
      echo "[setup] Copied Claude Code auth from host"
    else
      echo "[setup] WARNING: Could not copy Claude Code auth — host files may not be readable"
      echo "[setup]   Fix: grant only the container user access to the required Claude credential files, then restart. Do not make the credential directory world-readable."
    fi
  fi
  if [ -n "$rotated_claude" ]; then
    node /app/seed-cli-credentials.mjs claude "$rotated_claude" /home/node/.claude/.credentials.json || true
    rm -f "$rotated_claude"
  fi
  if [ -f /home/node/.claude-host.json ]; then
    cp /home/node/.claude-host.json /home/node/.claude.json
    echo "[setup] Copied Claude credentials file from host"
  fi
  rotated_codex=""
  if [ -f /home/node/.codex/auth.json ]; then
    rotated_codex="$(mktemp)"
    cp /home/node/.codex/auth.json "$rotated_codex" 2>/dev/null || rotated_codex=""
  fi
  if [ -d /home/node/.codex-host ] && [ "$(ls -A /home/node/.codex-host 2>/dev/null)" ]; then
    if cp -r /home/node/.codex-host/. /home/node/.codex/ 2>/dev/null; then
      echo "[setup] Copied Codex auth from host"
    else
      echo "[setup] WARNING: Could not copy Codex auth — host files may not be readable"
      echo "[setup]   Fix: grant only the container user access to the required Codex credential files, then restart. Do not make the credential directory world-readable."
    fi
  fi
  if [ -n "$rotated_codex" ]; then
    node /app/seed-cli-credentials.mjs codex "$rotated_codex" /home/node/.codex/auth.json || true
    rm -f "$rotated_codex"
  fi


  # Install CLI providers (cached in cli-cache volume). Versions are pinned so a
  # runtime "latest" cannot pull an unreviewed release into the image. Bump these
  # deliberately. Override at build/run time with CLAUDE_CODE_VERSION / CODEX_VERSION.
  for cli_provider in claude-code codex; do
    if ! node /app/update-cli.mjs "$cli_provider" --maintenance; then
      echo "[setup] WARNING: $cli_provider update failed; recheck its version in Settings"
    fi
  done
fi

# --- Start the app ---
# Force internal port to 3003 — env_file can leak HOST_PORT/PORT into the
# container, which would make Next.js bind to the wrong port (e.g. 80).
# The host-side mapping (HOST_PORT:3003) expects 3003 inside the container.
if [ -n "${PORT:-}" ] && [ "$PORT" != "3003" ]; then
  echo "[setup] WARNING: PORT is set to $PORT but the container expects 3003."
  echo "[setup]   Use HOST_PORT in .env to change the external port instead."
fi
export PORT=3003
echo "[setup] Starting Flight Finder on port ${PORT}..."
exec node apps/web/server.js
