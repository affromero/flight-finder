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

if [ -z "$ADMIN_PASSWORD" ]; then
  GENERATED_PW=$(generate_secret | head -c 16)
  export ADMIN_PASSWORD="$GENERATED_PW"
  echo ""
  echo "  ┌──────────────────────────────────────────┐"
  echo "  │  Admin password (auto-generated):        │"
  echo "  │  $GENERATED_PW  │"
  echo "  │                                          │"
  echo "  │  Set ADMIN_PASSWORD in .env to persist.  │"
  echo "  └──────────────────────────────────────────┘"
  echo ""
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
     --schema=apps/web/prisma/schema.prisma --url="$DATABASE_URL"; then
  echo "[setup] Schema ready"
else
  echo "[setup] ERROR: database schema push failed" >&2
  exit 1
fi

# --- CLI provider auth + install (Claude Code / Codex) ---
# Gated on INSTALL_CLI_PROVIDERS (default true), independent of app mode: the hosted
# production box installs the CLIs for the Claude Code provider, while fast hosted
# test stacks set INSTALL_CLI_PROVIDERS=false to skip the ~15s install.
if [ "$INSTALL_CLI_PROVIDERS" = "true" ]; then
  # Copy CLI auth from read-only host mounts into writable directories.
  # The installer mounts host ~/.claude and ~/.codex as read-only at *-host paths.
  # CLIs need write access (models cache, sessions), so we copy into writable dirs.
  if [ -d /home/node/.claude-host ] && [ "$(ls -A /home/node/.claude-host 2>/dev/null)" ]; then
    if cp -r /home/node/.claude-host/. /home/node/.claude/ 2>/dev/null; then
      echo "[setup] Copied Claude Code auth from host"
    else
      echo "[setup] WARNING: Could not copy Claude Code auth — host files may not be readable"
      echo "[setup]   Fix: run 'chmod -R a+rX ~/.claude' on the host, then restart"
    fi
  fi
  if [ -f /home/node/.claude-host.json ]; then
    cp /home/node/.claude-host.json /home/node/.claude.json
    echo "[setup] Copied Claude credentials file from host"
  fi
  if [ -d /home/node/.codex-host ] && [ "$(ls -A /home/node/.codex-host 2>/dev/null)" ]; then
    if cp -r /home/node/.codex-host/. /home/node/.codex/ 2>/dev/null; then
      echo "[setup] Copied Codex auth from host"
    else
      echo "[setup] WARNING: Could not copy Codex auth — host files may not be readable"
      echo "[setup]   Fix: run 'chmod -R a+rX ~/.codex' on the host, then restart"
    fi
  fi


  # Install CLI providers (cached in cli-cache volume). Versions are pinned so a
  # runtime "latest" cannot pull an unreviewed release into the image. Bump these
  # deliberately. Override at build/run time with CLAUDE_CODE_VERSION / CODEX_VERSION.
  CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.165}"
  CODEX_VERSION="${CODEX_VERSION:-0.137.0}"
  if ! command -v claude >/dev/null 2>&1; then
    echo "[setup] Installing Claude Code CLI (${CLAUDE_CODE_VERSION})..."
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" --prefer-offline --no-audit --no-fund 2>&1 | tail -1
    command -v claude >/dev/null 2>&1 && echo "[setup] Claude Code CLI ready" || echo "[setup] WARNING: Claude Code CLI install failed"
  fi

  if ! command -v codex >/dev/null 2>&1; then
    echo "[setup] Installing Codex CLI (${CODEX_VERSION})..."
    npm install -g "@openai/codex@${CODEX_VERSION}" --prefer-offline --no-audit --no-fund 2>&1 | tail -1
    command -v codex >/dev/null 2>&1 && echo "[setup] Codex CLI ready" || echo "[setup] WARNING: Codex CLI install failed"
  fi
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
