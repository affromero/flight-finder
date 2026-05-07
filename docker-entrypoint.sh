#!/bin/sh
set -e

echo "============================================"
echo "  Fairtrail — Flight Price Tracker"
echo "============================================"

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

if [ "${SELF_HOSTED:-true}" = "true" ] && [ -z "$CRON_SECRET" ]; then
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
  const { PrismaClient } = require('./node_modules/.prisma/client');
  const p = new PrismaClient();
  p.\$queryRaw\`SELECT 1\`.then(() => { p.\$disconnect(); process.exit(0); })
    .catch(() => { p.\$disconnect(); process.exit(1); });
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
# Pin prisma to the major version that matches the schema (currently v6).
# Without the pin, `npx prisma` fetches whatever the npm registry serves
# as latest, which broke deploys when Prisma 7 dropped `url = env(...)`.
# A future Dockerfile change should bundle the CLI + transitive deps so
# this stops round-tripping the registry entirely.
echo "[setup] Applying database schema..."
npx prisma@^6 db push --schema=apps/web/prisma/schema.prisma --skip-generate 2>&1 | tail -1
echo "[setup] Schema ready"

# --- Self-hosted only: CLI auth + install ---
# Skip on production server (SELF_HOSTED=false) to save ~15s startup time.
if [ "${SELF_HOSTED:-true}" = "true" ]; then
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


  # Install CLI providers (cached in cli-cache volume)
  if ! command -v claude >/dev/null 2>&1; then
    echo "[setup] Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code --prefer-offline --no-audit --no-fund 2>&1 | tail -1
    command -v claude >/dev/null 2>&1 && echo "[setup] Claude Code CLI ready" || echo "[setup] WARNING: Claude Code CLI install failed"
  fi

  if ! command -v codex >/dev/null 2>&1; then
    echo "[setup] Installing Codex CLI..."
    npm install -g @openai/codex --prefer-offline --no-audit --no-fund 2>&1 | tail -1
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
echo "[setup] Starting Fairtrail on port ${PORT}..."
exec node apps/web/server.js
