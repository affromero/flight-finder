#!/usr/bin/env bash
set -euo pipefail

# Flight Finder — One-command installer
# Usage: curl -fsSL https://flight-finder.org/install.sh | bash
#
# Installs the flight-finder CLI and Docker services to ~/.flight-finder
# No git clone, no build — pulls a pre-built image from GHCR.
#
# Want to inspect this script before running it?
#   curl -fsSL https://flight-finder.org/install.sh | less

BOLD='\033[1m'
DIM='\033[2m'
UNDERLINE='\033[4m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { printf "${CYAN}${BOLD}▸${RESET} %b\n" "$1"; }
ok()    { printf "${GREEN}${BOLD}✓${RESET} %b\n" "$1"; }
warn()  { printf "${YELLOW}${BOLD}!${RESET} %b\n" "$1"; }
fail()  { printf "${RED}${BOLD}✗${RESET} %b\n" "$1"; exit 1; }

FLIGHT_FINDER_DIR="$HOME/.flight-finder"
INSTALL_BIN="$HOME/.local/bin"
HOST_PORT="${HOST_PORT:-${PORT:-3003}}"
BASE_URL="${FLIGHT_FINDER_URL:-https://flight-finder.org}"
# Test overrides (used by scripts/install-flow-test.sh)
FLIGHT_FINDER_REPO="https://github.com/affromero/flight-finder.git"
FLIGHT_FINDER_API_KEY="${FLIGHT_FINDER_API_KEY:-}"
FLIGHT_FINDER_API_PROVIDER="${FLIGHT_FINDER_API_PROVIDER:-}"
FLIGHT_FINDER_EXTRA_ENV="${FLIGHT_FINDER_EXTRA_ENV:-}"

# Parse install-time flags. --no-browser suppresses the auto-open at the end
# (use for SSH, CI, or server installs that have no display).
FLIGHT_FINDER_OPEN_BROWSER="${FLIGHT_FINDER_OPEN_BROWSER:-1}"
for arg in "$@"; do
  case "$arg" in
    --no-browser) FLIGHT_FINDER_OPEN_BROWSER=0 ;;
  esac
done

echo ""
printf "${BOLD}  Flight Finder — Flight Price Tracker${RESET}\n"
printf "  ${DIM}The price trail airlines don't show you${RESET}\n"
echo ""

# ---------------------------------------------------------------------------
# 0. Transparency summary — show what this installer does before proceeding
# ---------------------------------------------------------------------------
printf "  ${BOLD}This installer will:${RESET}\n"
echo ""
printf "  ${DIM}1.${RESET} Install 3 Docker containers to ${BOLD}~/.flight-finder/${RESET}\n"
printf "     ${DIM}• PostgreSQL 16 (your local database — nothing leaves your machine)${RESET}\n"
printf "     ${DIM}• Redis 7 (local cache)${RESET}\n"
printf "     ${DIM}• Flight Finder web app (built locally from source)${RESET}\n"
echo ""
printf "  ${DIM}2.${RESET} Download the ${BOLD}flight-finder${RESET} CLI to ${BOLD}~/.local/bin/${RESET}\n"
echo ""
printf "  ${DIM}3.${RESET} Generate a local ${BOLD}.env${RESET} config file in ~/.flight-finder/\n"
echo ""
printf "  ${DIM}No data leaves your machine. No account required.${RESET}\n"
printf "  ${DIM}Open source (MIT) — ${BOLD}https://github.com/affromero/flight-finder${RESET}\n"
echo ""

# Allow non-interactive mode (e.g., CI) by setting FLIGHT_FINDER_YES=1
if [ "${FLIGHT_FINDER_YES:-}" != "1" ]; then
  read -rp "  Continue? [Y/n] " CONSENT < /dev/tty
  if [[ "$CONSENT" =~ ^[Nn]$ ]]; then
    echo ""
    printf "  ${DIM}No changes were made. Inspect the script:${RESET}\n"
    printf "  ${BOLD}curl -fsSL https://flight-finder.org/install.sh | less${RESET}\n"
    echo ""
    exit 0
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# 1. Detect OS and check prerequisites
# ---------------------------------------------------------------------------
OS="unknown"
case "$(uname -s)" in
  Darwin*)  OS="macos" ;;
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      OS="wsl"
    else
      OS="linux"
    fi
    ;;
esac

# Detect Linux distro family. get.docker.com supports Debian/Ubuntu/Fedora/RHEL
# but rejects Arch and derivatives, which ship Docker via pacman instead.
DISTRO_FAMILY=""
if [ "$OS" = "linux" ] || [ "$OS" = "wsl" ]; then
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    case "${ID:-}" in
      arch|manjaro|endeavouros|garuda|artix|cachyos)
        DISTRO_FAMILY="arch" ;;
      *)
        case " ${ID_LIKE:-} " in
          *" arch "*) DISTRO_FAMILY="arch" ;;
        esac ;;
    esac
  fi
fi

install_docker_linux() {
  info "Installing Docker Engine..."
  if ! command -v sudo &>/dev/null; then
    fail "sudo is required to install Docker. Install sudo first, then re-run."
  fi
  printf "  ${DIM}This requires sudo — you may be prompted for your password.${RESET}\n"
  if [ "$DISTRO_FAMILY" = "arch" ]; then
    # Arch family: get.docker.com refuses to run, so install via pacman.
    sudo pacman -Sy --needed --noconfirm docker docker-compose
    sudo systemctl enable --now docker.service
  else
    curl -fsSL https://get.docker.com | sudo sh
  fi
  sudo usermod -aG docker "$USER"
  warn "You were added to the docker group. Log out and back in, then re-run this installer."
  exit 0
}

if ! command -v git &>/dev/null; then
  fail "git is required to install Flight Finder.\n\n  Install: ${BOLD}sudo apt install git${RESET} (Debian/Ubuntu), ${BOLD}sudo dnf install git${RESET} (Fedora), or ${BOLD}sudo pacman -S git${RESET} (Arch/Manjaro)"
fi

if command -v docker &>/dev/null; then
  CONTAINER_CMD=docker
elif command -v podman &>/dev/null; then
  CONTAINER_CMD=podman
else
  case "$OS" in
    macos)
      fail "Docker Desktop or Podman is required.\n\n  Docker: ${BOLD}https://docs.docker.com/desktop/setup/install/mac-install/${RESET}\n  Podman: ${BOLD}https://podman.io/docs/installation${RESET}\n\n  Then re-run: ${BOLD}curl -fsSL https://flight-finder.org/install.sh | bash${RESET}"
      ;;
    linux|wsl)
      warn "Docker is not installed."
      echo ""
      read -rp "  Install Docker Engine now? (requires sudo) [Y/n] " confirm < /dev/tty
      if [[ ! "$confirm" =~ ^[Nn]$ ]]; then
        install_docker_linux
      else
        fail "Docker or Podman is required.\n  Docker: https://docs.docker.com/engine/install/\n  Podman: https://podman.io/docs/installation"
      fi
      ;;
    *)
      fail "Docker or Podman is required.\n  Docker: https://docs.docker.com/get-docker/\n  Podman: https://podman.io/docs/installation"
      ;;
  esac
fi

if [ "$CONTAINER_CMD" = "docker" ]; then
  # Capture stderr so we can distinguish permission-denied (user is not in
  # the docker group / shell session has not picked up new group membership)
  # from daemon-down. The previous version always told the user to start the
  # daemon, which is wrong on the common Manjaro/Arch path where the daemon
  # is already running but the current shell cannot reach the socket. See #62.
  #
  # Gate on exit status, not stderr presence: docker info can exit 0 while
  # writing warnings to stderr (deprecated config, plugin notices, etc).
  if ! docker_info_err=$(docker info 2>&1 1>/dev/null); then
    case "$docker_info_err" in
      *"permission denied"*|*"Permission denied"*)
        case "$OS" in
          linux|wsl)
            fail "Docker is running but your user cannot access the socket.\n\n  This usually means you are not in the ${BOLD}docker${RESET} group, or your\n  current shell session has not picked up that membership yet.\n\n  Try one of these:\n    ${BOLD}newgrp docker${RESET}  ${DIM}# refresh group in this shell, then re-run${RESET}\n    Log out and back in fully (close all terminals), then re-run\n    Reboot, then re-run\n\n  If you are not yet in the docker group:\n    ${BOLD}sudo usermod -aG docker \$USER${RESET}  ${DIM}# then log out + in${RESET}"
            ;;
          *)
            fail "Docker socket is not accessible (permission denied).\n  Run this installer as a user that can access the docker socket."
            ;;
        esac
        ;;
      *)
        case "$OS" in
          macos)
            fail "Docker Desktop is not running.\n\n  Open Docker Desktop from Applications, wait for it to start, then re-run:\n  ${BOLD}curl -fsSL https://flight-finder.org/install.sh | bash${RESET}"
            ;;
          linux|wsl)
            warn "Docker daemon is not running."
            printf "  ${DIM}Trying to start it...${RESET}\n"
            if command -v sudo &>/dev/null; then
              sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null || true
              sleep 2
            fi
            if ! docker info &>/dev/null 2>&1; then
              fail "Could not start Docker.\n\n  Start it manually: ${BOLD}sudo systemctl start docker${RESET}\n  Then re-run this installer."
            fi
            ok "Docker daemon started"
            ;;
          *)
            fail "Docker is not running. Start Docker and try again."
            ;;
        esac
        ;;
    esac
  fi
  ok "Docker is running"
else
  ok "Podman is available"
fi

# Detect compose command based on detected container runtime
if [ "$CONTAINER_CMD" = "podman" ]; then
  if podman compose version &>/dev/null 2>&1; then
    DC="podman compose"
  elif command -v podman-compose &>/dev/null; then
    DC="podman-compose"
  else
    fail "podman compose is required.\n\n  Install podman-compose: ${BOLD}https://github.com/containers/podman-compose${RESET}"
  fi
elif docker compose version &>/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  fail "Neither 'docker compose' (v2) nor 'docker-compose' (v1) found.\n\n  Install Docker Compose: ${BOLD}https://docs.docker.com/compose/install/${RESET}"
fi

# ---------------------------------------------------------------------------
# 1b. Check if port is available
# ---------------------------------------------------------------------------
port_in_use() {
  if command -v lsof &>/dev/null; then
    lsof -i :"$1" &>/dev/null
  elif command -v ss &>/dev/null; then
    ss -tlnp | grep -q ":$1 "
  elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep -q ":$1 "
  else
    return 1
  fi
}

while port_in_use "$HOST_PORT"; do
  warn "Port ${HOST_PORT} is already in use."
  if [ "${FLIGHT_FINDER_YES:-}" = "1" ]; then
    HOST_PORT=$((HOST_PORT + 1))
  else
    echo ""
    read -rp "  Enter a different port [default: $((HOST_PORT + 1))]: " NEW_PORT < /dev/tty
    HOST_PORT="${NEW_PORT:-$((HOST_PORT + 1))}"
  fi
done

ok "Port ${HOST_PORT} is available"

# ---------------------------------------------------------------------------
# 2. Migrate from old install location
# ---------------------------------------------------------------------------
if [ -d "$HOME/fairtrail" ] && [ ! -d "$FLIGHT_FINDER_DIR" ]; then
  warn "Found old install at ~/fairtrail"
  printf "  ${DIM}The new install location is ~/.flight-finder${RESET}\n"
  printf "  ${DIM}Your Docker volumes (tracked queries, price data) are preserved.${RESET}\n"
  echo ""

  # Stop old containers if a compose file exists
  if [ -f "$HOME/fairtrail/docker-compose.yml" ]; then
    info "Stopping old containers..."
    $DC -f "$HOME/fairtrail/docker-compose.yml" down 2>/dev/null || true
  fi

  # Clean up old directory
  if [ "${FLIGHT_FINDER_YES:-}" = "1" ]; then
    mv "$HOME/fairtrail" "$HOME/fairtrail.old-backup"
    ok "Moved ~/fairtrail to ~/fairtrail.old-backup"
  else
    read -rp "  Remove old ~/fairtrail directory? [Y/n] " REMOVE_OLD < /dev/tty
    if [[ ! "$REMOVE_OLD" =~ ^[Nn]$ ]]; then
      mv "$HOME/fairtrail" "$HOME/fairtrail.old-backup"
      ok "Moved ~/fairtrail to ~/fairtrail.old-backup"
    else
      warn "Old directory left at ~/fairtrail (you can remove it later)"
    fi
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# 2b. Migrate from pre-rename install (~/.fairtrail -> ~/.flight-finder)
# ---------------------------------------------------------------------------
# Renames the database fairtrail -> flight_finder while the old containers are
# still wired to it, then moves the install directory. A marker keeps
# `name: fairtrail` at the top of the regenerated compose so the existing
# flight-finder_pgdata / redisdata / app-data / cli-cache volumes stay attached
# without a data copy.
if [ -d "$HOME/.fairtrail" ] && [ ! -d "$FLIGHT_FINDER_DIR" ]; then
  warn "Found pre-rename install at ~/.fairtrail"
  printf "  ${DIM}Migrating to ~/.flight-finder (Flight Finder rename).${RESET}\n"
  printf "  ${DIM}Your tracked queries, prices, and settings are preserved.${RESET}\n"
  echo ""

  if [ -f "$HOME/.fairtrail/docker-compose.yml" ]; then
    info "Renaming database fairtrail -> flight_finder..."

    $DC -f "$HOME/.fairtrail/docker-compose.yml" up -d db >/dev/null 2>&1 || true

    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if $DC -f "$HOME/.fairtrail/docker-compose.yml" exec -T db pg_isready -U postgres >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    EXISTS=$($DC -f "$HOME/.fairtrail/docker-compose.yml" exec -T db psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='fairtrail'" 2>/dev/null | tr -d '[:space:]' || true)
    if [ "$EXISTS" = "1" ]; then
      $DC -f "$HOME/.fairtrail/docker-compose.yml" stop web >/dev/null 2>&1 || true
      if $DC -f "$HOME/.fairtrail/docker-compose.yml" exec -T db psql -U postgres -d postgres -c "ALTER DATABASE fairtrail RENAME TO flight_finder;" >/dev/null 2>&1; then
        ok "Database renamed to flight_finder"
      else
        fail "Failed to rename database fairtrail -> flight_finder. Old install at ~/.fairtrail is untouched."
      fi
    else
      info "Database already renamed (skipping)"
    fi

    info "Stopping old containers..."
    $DC -f "$HOME/.fairtrail/docker-compose.yml" down >/dev/null 2>&1 || true
  fi

  mv "$HOME/.fairtrail" "$FLIGHT_FINDER_DIR"
  ok "Moved ~/.fairtrail to $FLIGHT_FINDER_DIR"

  touch "$FLIGHT_FINDER_DIR/.migrated-from-fairtrail"
  echo ""
elif [ -d "$HOME/.fairtrail" ] && [ -d "$FLIGHT_FINDER_DIR" ]; then
  warn "Both ~/.fairtrail and ~/.flight-finder exist (interrupted migration?)"
  printf "  ${DIM}Refusing to auto resolve. If ~/.flight-finder is canonical, remove the old dir:${RESET}\n"
  printf "  ${BOLD}rm -rf ~/.fairtrail${RESET}\n"
  printf "  ${DIM}Or retry the migration from scratch:${RESET}\n"
  printf "  ${BOLD}rm -rf ~/.flight-finder && curl -fsSL ${BASE_URL}/install.sh | bash${RESET}\n"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Create install directory + write docker-compose.yml
# ---------------------------------------------------------------------------
mkdir -p "$FLIGHT_FINDER_DIR"

# When this install was migrated from ~/.fairtrail, keep `name: fairtrail` at
# the top of the generated compose. That maps the project name back to the
# legacy `fairtrail_*` named volumes so existing data stays attached.
COMPOSE_NAME_LINE=""
if [ -f "$FLIGHT_FINDER_DIR/.migrated-from-fairtrail" ]; then
  COMPOSE_NAME_LINE="name: fairtrail"
fi


EXTRA_HOSTS_BLOCK=""
if [ "$CONTAINER_CMD" != "podman" ]; then
  EXTRA_HOSTS_BLOCK='    extra_hosts:
      - "host.docker.internal:host-gateway"'
fi

cat > "$FLIGHT_FINDER_DIR/docker-compose.yml" << COMPOSE
${COMPOSE_NAME_LINE}
services:
  db:
    image: docker.io/library/postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: flight_finder
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: docker.io/library/redis:7-alpine
    restart: unless-stopped
    volumes:
      - redisdata:/data
    ports:
      - "127.0.0.1:6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  web:
    image: ghcr.io/affromero/flight-finder:latest
    build: ./repo
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "\${HOST_PORT:-3003}:3003"
    env_file: .env
    environment:
      DATABASE_URL: postgresql://postgres:\${POSTGRES_PASSWORD:-postgres}@db:5432/flight_finder
      REDIS_URL: \${REDIS_URL:-redis://redis:6379}
      CHROME_PATH: /usr/bin/chromium-browser
      NODE_ENV: production
      SELF_HOSTED: "true"
$EXTRA_HOSTS_BLOCK
    volumes:
      - app-data:/app/data
      - cli-cache:/home/node/.npm-global

volumes:
  pgdata:
  redisdata:
  app-data:
  cli-cache:
COMPOSE

ok "Created ~/.flight-finder"

# ---------------------------------------------------------------------------
# 4. Install the flight-finder CLI
# ---------------------------------------------------------------------------
mkdir -p "$INSTALL_BIN"

if [ -n "${FLIGHT_FINDER_CLI_SOURCE:-}" ] && [ -f "$FLIGHT_FINDER_CLI_SOURCE" ]; then
  cp "$FLIGHT_FINDER_CLI_SOURCE" "$INSTALL_BIN/flight-finder"
  chmod +x "$INSTALL_BIN/flight-finder"
  # Helper sits next to the CLI source; copy it too (issue #72).
  _flags_src="$(dirname "$FLIGHT_FINDER_CLI_SOURCE")/flight-finder-cli-flags.sh"
  if [ -f "$_flags_src" ]; then
    cp "$_flags_src" "$INSTALL_BIN/flight-finder-cli-flags.sh"
  else
    fail "Missing $_flags_src — required helper for compose-flavor flag handling"
  fi
  ok "Installed flight-finder CLI from local source"
else
  info "Downloading CLI..."
  if curl -fsSL "$BASE_URL/flight-finder-cli" -o "$INSTALL_BIN/flight-finder.tmp" 2>/dev/null; then
    mv -f "$INSTALL_BIN/flight-finder.tmp" "$INSTALL_BIN/flight-finder"
    chmod +x "$INSTALL_BIN/flight-finder"
    ok "Installed flight-finder to $INSTALL_BIN/flight-finder"
  else
    rm -f "$INSTALL_BIN/flight-finder.tmp"
    fail "Failed to download CLI from $BASE_URL/flight-finder-cli"
  fi
  # Compose-flavor flag helper (issue #72). Hard requirement on podman.
  if curl -fsSL "$BASE_URL/flight-finder-cli-flags.sh" -o "$INSTALL_BIN/flight-finder-cli-flags.sh.tmp" 2>/dev/null; then
    mv -f "$INSTALL_BIN/flight-finder-cli-flags.sh.tmp" "$INSTALL_BIN/flight-finder-cli-flags.sh"
  else
    rm -f "$INSTALL_BIN/flight-finder-cli-flags.sh.tmp"
    fail "Failed to download flag helper from $BASE_URL/flight-finder-cli-flags.sh"
  fi
fi

# Install the flightfinder alias as a sibling symlink (single word, faster to type).
ln -sf flight-finder "$INSTALL_BIN/flightfinder"

# Keep the legacy fairtrail command working as a deprecated alias.
# The wrapper prints a one line deprecation notice when invoked under this name.
# Sunset target: v1.0.
ln -sf flight-finder "$INSTALL_BIN/fairtrail"

# Ensure ~/.local/bin is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_BIN"; then
  EXPORT_LINE='export PATH="$HOME/.local/bin:$PATH"'
  PATCHED=false

  patch_profile() {
    local file="$1"
    if [ -f "$file" ] && ! grep -qF '.local/bin' "$file" 2>/dev/null; then
      printf '\n# Added by Flight Finder installer\n%s\n' "$EXPORT_LINE" >> "$file"
      ok "Added $INSTALL_BIN to PATH in $file"
      PATCHED=true
    fi
  }

  if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
    patch_profile "$HOME/.zshrc"
  else
    # Patch .bashrc for interactive shells
    patch_profile "$HOME/.bashrc"
    # ALSO patch .profile (or .bash_profile) for SSH login shells.
    # SSH sessions source .profile, not .bashrc, so both are needed.
    if [ -f "$HOME/.bash_profile" ]; then
      patch_profile "$HOME/.bash_profile"
    else
      patch_profile "$HOME/.profile"
    fi
  fi

  if [ "$PATCHED" = false ]; then
    warn "$INSTALL_BIN is not in your PATH"
    printf "  Add this to your shell profile:\n"
    printf "  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi

  # Make it available for the rest of this script
  export PATH="$INSTALL_BIN:$PATH"
fi

# ---------------------------------------------------------------------------
# 5. Detect LLM providers (Claude Code CLI / Codex CLI / Ollama / API key)
# ---------------------------------------------------------------------------
CLAUDE_CODE_DETECTED=false
CODEX_DETECTED=false
OLLAMA_DETECTED=false
OLLAMA_HOST_VAL=""
API_KEY_VAR=""
API_KEY_VAL=""

if command -v claude &>/dev/null && [ -d "$HOME/.claude" ]; then
  CLAUDE_CODE_DETECTED=true
  ok "Claude Code CLI detected — no API key needed"
fi

# On macOS, Claude Code stores OAuth tokens in the system Keychain, which is
# inaccessible from inside Docker. A separate long-lived token is needed.
CLAUDE_SETUP_TOKEN=""
if [ "$CLAUDE_CODE_DETECTED" = true ] && [ "$OS" = "macos" ]; then
  echo ""
  warn "macOS detected — Docker cannot access your Claude Code Keychain credentials"
  echo ""
  printf "  ${DIM}To use your Claude subscription inside Docker, you need a separate token.${RESET}\n"
  printf "  ${DIM}This is a one-time setup — the token lasts 1 year.${RESET}\n"
  echo ""
  printf "  ${BOLD}1.${RESET} Open another terminal and run:  ${BOLD}claude setup-token${RESET}\n"
  printf "  ${BOLD}2.${RESET} Complete the browser authorization\n"
  printf "  ${BOLD}3.${RESET} Paste the token here (starts with sk-ant-)\n"
  echo ""

  if [ "${FLIGHT_FINDER_YES:-}" = "1" ]; then
    warn "Non-interactive mode — skipping setup-token prompt"
  else
    read -rsp "  Token (or Enter to skip): " CLAUDE_SETUP_TOKEN < /dev/tty
    echo ""
    if [ -n "$CLAUDE_SETUP_TOKEN" ]; then
      ok "Claude Code setup token saved"
    else
      warn "Skipped — Claude Code will not work until you configure a token"
      printf "  ${DIM}You can add it later: edit ~/.flight-finder/.env and add CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...${RESET}\n"
    fi
  fi
fi

if command -v codex &>/dev/null && [ -d "$HOME/.codex" ]; then
  CODEX_DETECTED=true
  ok "Codex CLI detected — no API key needed"
fi

# Detect Ollama running locally
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  OLLAMA_DETECTED=true
  OLLAMA_MODELS=$(curl -sf http://localhost:11434/api/tags 2>/dev/null \
    | python3 -c "import sys,json; [print(m['name']) for m in json.load(sys.stdin).get('models',[])]" 2>/dev/null \
    || true)
  OLLAMA_MODEL_COUNT=$(echo "$OLLAMA_MODELS" | grep -c . 2>/dev/null || echo 0)
  ok "Ollama detected — ${OLLAMA_MODEL_COUNT} model(s) installed locally"

  if [ "$CONTAINER_CMD" = "podman" ]; then
    OLLAMA_HOST_VAL="http://host.containers.internal:11434"
  else
    OLLAMA_HOST_VAL="http://host.docker.internal:11434"
  fi
fi

HAS_CLI_OR_LOCAL=false
if [ "$CLAUDE_CODE_DETECTED" = true ] || [ "$CODEX_DETECTED" = true ] || [ "$OLLAMA_DETECTED" = true ]; then
  HAS_CLI_OR_LOCAL=true
fi

# Pre-set API key from env (for testing)
if [ -n "$FLIGHT_FINDER_API_KEY" ] && [ -n "$FLIGHT_FINDER_API_PROVIDER" ]; then
  API_KEY_VAR="$FLIGHT_FINDER_API_PROVIDER"
  API_KEY_VAL="$FLIGHT_FINDER_API_KEY"
  HAS_CLI_OR_LOCAL=true
  ok "Using pre-configured $FLIGHT_FINDER_API_PROVIDER"
fi

if [ "$HAS_CLI_OR_LOCAL" = false ]; then
  warn "No Claude Code, Codex CLI, or Ollama found"

  if [ "${FLIGHT_FINDER_YES:-}" = "1" ]; then
    warn "Non-interactive mode — skipping API key prompt"
  else
    echo ""
    printf "  Paste an API key from any provider, or press Enter to skip:\n"
    printf "  ${DIM}1. Anthropic  — https://console.anthropic.com/${RESET}\n"
    printf "  ${DIM}2. OpenAI     — https://platform.openai.com/api-keys${RESET}\n"
    printf "  ${DIM}3. Google AI  — https://aistudio.google.com/apikey${RESET}\n"
    printf "  ${DIM}4. Ollama     — https://ollama.com (install locally, then re-run)${RESET}\n"
    echo ""
    read -rsp "  API key (or Enter to skip): " API_KEY_VAL < /dev/tty
    echo ""
  fi

  if [ -z "$API_KEY_VAL" ]; then
    warn "No API key — you can configure a provider later in the admin panel"
  elif [[ "$API_KEY_VAL" == sk-ant-* ]]; then
    API_KEY_VAR="ANTHROPIC_API_KEY"
    ok "Detected Anthropic key"
  elif [[ "$API_KEY_VAL" == sk-* ]]; then
    API_KEY_VAR="OPENAI_API_KEY"
    ok "Detected OpenAI key"
  elif [[ "$API_KEY_VAL" == AI* ]]; then
    API_KEY_VAR="GOOGLE_AI_API_KEY"
    ok "Detected Google AI key"
  else
    echo ""
    echo "  Which provider is this key for?"
    echo "  1) Anthropic"
    echo "  2) OpenAI"
    echo "  3) Google AI"
    read -rp "  Choice [1-3]: " PROVIDER_CHOICE < /dev/tty
    case "$PROVIDER_CHOICE" in
      1) API_KEY_VAR="ANTHROPIC_API_KEY" ;;
      2) API_KEY_VAR="OPENAI_API_KEY" ;;
      3) API_KEY_VAR="GOOGLE_AI_API_KEY" ;;
      *) fail "Invalid choice" ;;
    esac
    ok "Using ${API_KEY_VAR}"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Generate .env
# ---------------------------------------------------------------------------
if [ -f "$FLIGHT_FINDER_DIR/.env" ]; then
  # Never clobber an existing .env, but non-destructively add any provider key
  # detected or provided in this run that is not already present. Without this,
  # re-running the installer to add a key was a silent no-op (#152). Existing
  # lines (and any unrelated config) are left exactly as they are.
  ENV_FILE="$FLIGHT_FINDER_DIR/.env"
  ENV_ADDED=0
  append_env_if_missing() {
    # $1 = key name, $2 = value, $3 = optional comment line
    local _key="$1" _val="$2" _comment="${3:-}"
    [ -n "$_val" ] || return 0
    if grep -qE "^${_key}=" "$ENV_FILE"; then
      return 0
    fi
    {
      echo ""
      if [ -n "$_comment" ]; then echo "$_comment"; fi
      echo "${_key}=${_val}"
    } >> "$ENV_FILE"
    ENV_ADDED=$((ENV_ADDED + 1))
    ok "Added ${_key} to existing .env"
  }
  if [ -n "$API_KEY_VAR" ]; then
    append_env_if_missing "$API_KEY_VAR" "$API_KEY_VAL"
  fi
  append_env_if_missing "OLLAMA_HOST" "$OLLAMA_HOST_VAL" "# Ollama (Docker-compatible address)"
  append_env_if_missing "CLAUDE_CODE_OAUTH_TOKEN" "${CLAUDE_SETUP_TOKEN:-}" "# Claude Code setup token (long-lived, from 'claude setup-token')"
  if [ "$ENV_ADDED" -eq 0 ]; then
    warn "Existing .env found — no new keys to add, keeping it as is"
  else
    ok "Updated existing .env with ${ENV_ADDED} new key(s) — restart the stack to apply"
  fi
else
  # Generate a random 48-char hex password for PostgreSQL. Using a random value
  # means each self-hosted install has a unique credential instead of the
  # default "postgres", which is otherwise exposed on 127.0.0.1:5433.
  GENERATED_PG_PASSWORD=$(openssl rand -hex 24 2>/dev/null \
    || LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 48)
  {
    echo "# Generated by Flight Finder installer — $(date -u '+%Y-%m-%d %H:%M UTC')"
    echo "POSTGRES_PASSWORD=${GENERATED_PG_PASSWORD}"
    echo ""
    echo "# Host port — the port YOU access in the browser."
    echo "# The container always listens on 3003 internally; do NOT set PORT."
    echo "HOST_PORT=${HOST_PORT}"
    echo ""
    if [ -n "$API_KEY_VAR" ]; then
      echo "${API_KEY_VAR}=${API_KEY_VAL}"
    fi
    if [ -n "$OLLAMA_HOST_VAL" ]; then
      echo ""
      echo "# Ollama (Docker-compatible address)"
      echo "OLLAMA_HOST=${OLLAMA_HOST_VAL}"
    fi
    if [ -n "${CLAUDE_SETUP_TOKEN:-}" ]; then
      echo ""
      echo "# Claude Code setup token (long-lived, from 'claude setup-token')"
      echo "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_SETUP_TOKEN}"
    fi
    if [ -n "$FLIGHT_FINDER_EXTRA_ENV" ]; then
      echo ""
      echo "# Extra env (test overrides)"
      echo "$FLIGHT_FINDER_EXTRA_ENV"
    fi
  } > "$FLIGHT_FINDER_DIR/.env"
  ok "Generated .env"
fi

# ---------------------------------------------------------------------------
# 6b. Optional: ExpressVPN for price comparison across countries
# ---------------------------------------------------------------------------
printf "\n"
printf "  ${BOLD}VPN Price Comparison (optional)${RESET}\n"
printf "  ${DIM}Compare flight prices from different countries using ExpressVPN.${RESET}\n"
printf "  ${DIM}Requires an ExpressVPN subscription.${RESET}\n"
printf "\n"
if [ "${FLIGHT_FINDER_YES:-}" = "1" ]; then
  SETUP_VPN="n"
else
  printf "  Set up ExpressVPN? [y/N] "
  read -r SETUP_VPN < /dev/tty
fi
if [ "$SETUP_VPN" = "y" ] || [ "$SETUP_VPN" = "Y" ]; then
  printf "  Paste your activation code (from ${UNDERLINE}https://www.expressvpn.com/setup${RESET}): "
  read -r EXPRESSVPN_CODE < /dev/tty
  if [ -n "$EXPRESSVPN_CODE" ]; then
    # Append to .env
    {
      echo ""
      echo "# ExpressVPN (VPN price comparison)"
      echo "EXPRESSVPN_CODE=${EXPRESSVPN_CODE}"
    } >> "$FLIGHT_FINDER_DIR/.env"

    # Generate docker-compose.vpn.yml
    # Supply-chain note (INFRA-6/7): the expressvpn image is a community image
    # that does not publish versioned tags, so :latest cannot be pinned to a
    # specific digest here without breaking future updates. The container runs
    # with NET_ADMIN and /dev/net/tun, which makes supply-chain trust important.
    # Risk accepted: the image is optional, user-initiated, and protected by
    # Docker Hub content trust if DOCKER_CONTENT_TRUST=1 is set. Pin to a digest
    # manually once you have verified the image, or replace with an official
    # ExpressVPN image if one becomes available.
    cat > "$FLIGHT_FINDER_DIR/docker-compose.vpn.yml" << 'VPNYAML'
services:
  expressvpn:
    image: docker.io/misioslav/expressvpn:latest
    container_name: flight-finder-expressvpn
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      - ACTIVATION_CODE=${EXPRESSVPN_CODE}
      - SERVER=smart
      - PROTOCOL=auto
      - SOCKS_ENABLED=true
      - SOCKS_PORT=1080
      - API_ENABLED=true
      - API_PORT=8000
      - HEALTHCHECK=true
      - NETWORK=on
    stdin_open: true
    tty: true
    healthcheck:
      test: ["CMD", "expressvpnctl", "status"]
      interval: 30s
      timeout: 10s
      retries: 3

  web:
    environment:
      - EXPRESSVPN_API_URL=http://expressvpn:8000
      - EXPRESSVPN_SOCKS_URL=socks5://expressvpn:1080
    depends_on:
      expressvpn:
        condition: service_healthy
VPNYAML
    # Set COMPOSE_FILE so docker compose auto-includes vpn sidecar
    export COMPOSE_FILE="docker-compose.yml:docker-compose.vpn.yml"
    ok "VPN configured — sidecar will start automatically"
  else
    printf "  ${DIM}Skipped (no code entered)${RESET}\n"
  fi
else
  printf "  ${DIM}Skipped${RESET}\n"
fi

# ---------------------------------------------------------------------------
# 7. Generate docker-compose.override.yml for CLI volume mounts
# ---------------------------------------------------------------------------
NEED_OVERRIDE=false
OVERRIDE_VOLUMES=""
MOUNT_CONSENT=true

if [ "$CLAUDE_CODE_DETECTED" = true ] || [ "$CODEX_DETECTED" = true ]; then
  echo ""
  info "Mounting CLI credentials (read-only)"
  echo ""
  printf "  ${DIM}To use your existing CLI subscription instead of a separate API key,${RESET}\n"
  printf "  ${DIM}Flight Finder needs read-only access to your CLI auth tokens:${RESET}\n"
  echo ""
  if [ "$CLAUDE_CODE_DETECTED" = true ]; then
    printf "    ${DIM}~/.claude.json + ~/.claude  →  mounted as read-only (:ro)${RESET}\n"
  fi
  if [ "$CODEX_DETECTED" = true ]; then
    printf "    ${DIM}~/.codex   →  mounted as read-only (:ro)${RESET}\n"
  fi
  echo ""
  printf "  ${DIM}The container cannot modify these files. Your tokens are never copied or sent anywhere.${RESET}\n"
  echo ""

  if [ "${FLIGHT_FINDER_YES:-}" != "1" ]; then
    read -rp "  Allow read-only credential mount? [Y/n] " MOUNT_CHOICE < /dev/tty
    if [[ "$MOUNT_CHOICE" =~ ^[Nn]$ ]]; then
      MOUNT_CONSENT=false
      warn "Skipped credential mount — you'll need to provide an API key in setup"
    fi
  fi
fi

if [ "$MOUNT_CONSENT" = true ]; then
  if [ "$CLAUDE_CODE_DETECTED" = true ]; then
    NEED_OVERRIDE=true
    OVERRIDE_VOLUMES="${OVERRIDE_VOLUMES}
      - ${HOME}/.claude:/home/node/.claude-host:ro"
    if [ -f "${HOME}/.claude.json" ]; then
      OVERRIDE_VOLUMES="${OVERRIDE_VOLUMES}
      - ${HOME}/.claude.json:/home/node/.claude-host.json:ro"
    fi
  fi

  if [ "$CODEX_DETECTED" = true ]; then
    NEED_OVERRIDE=true
    OVERRIDE_VOLUMES="${OVERRIDE_VOLUMES}
      - ${HOME}/.codex:/home/node/.codex-host:ro"
  fi
fi

if [ "$NEED_OVERRIDE" = true ]; then
  cat > "$FLIGHT_FINDER_DIR/docker-compose.override.yml" << YAML
# Auto-generated — mounts CLI auth into the container (read-only)
services:
  web:
    volumes:${OVERRIDE_VOLUMES}
YAML
  ok "Mounted CLI credentials (read-only)"
else
  rm -f "$FLIGHT_FINDER_DIR/docker-compose.override.yml"
fi

# ---------------------------------------------------------------------------
# 8. Pull image and start
# ---------------------------------------------------------------------------
cd "$FLIGHT_FINDER_DIR"

if [ "${FLIGHT_FINDER_SKIP_BUILD:-}" = "1" ]; then
  ok "Using existing image (build skipped)"
elif $DC pull web 2>/dev/null; then
  ok "Pulled pre-built image"
else
  info "No pre-built image for this architecture, building locally..."
  info "This takes a few minutes on first run"
  echo ""

  # Ensure repo is cloned for local builds
  if [ ! -d "$FLIGHT_FINDER_DIR/repo/.git" ]; then
    git clone --depth 1 -q "$FLIGHT_FINDER_REPO" "$FLIGHT_FINDER_DIR/repo"
  fi

  $DC build 2>&1 | while IFS= read -r line; do
    printf "  ${DIM}%s${RESET}\n" "$line"
  done
fi


if [ "${FLIGHT_FINDER_SKIP_START:-}" = "1" ]; then
  ok "Skipping container start (test mode)"
else
  $DC up -d 2>&1 | while IFS= read -r line; do
    printf "  ${DIM}%s${RESET}\n" "$line"
  done

  echo ""

  # ---------------------------------------------------------------------------
  # 9. Wait for the app to be ready
  # ---------------------------------------------------------------------------
  info "Waiting for the app to start..."

  RETRIES=60
  until curl -sf "http://localhost:${HOST_PORT}/api/health" >/dev/null 2>&1; do
    RETRIES=$((RETRIES - 1))
    if [ "$RETRIES" -le 0 ]; then
      warn "App didn't respond in 60s — run 'flight-finder logs' to debug"
      break
    fi
    sleep 1
  done

  if [ "$RETRIES" -gt 0 ]; then
    ok "Flight Finder is running"
  fi
fi

# ---------------------------------------------------------------------------
# 10. Print summary
# ---------------------------------------------------------------------------
echo ""
printf "${BOLD}  ┌──────────────────────────────────────────────────┐${RESET}\n"
printf "${BOLD}  │                                                  │${RESET}\n"
printf "${BOLD}  │${RESET}   ${CYAN}Flight Finder is ready${RESET}                            ${BOLD}│${RESET}\n"
printf "${BOLD}  │${RESET}                                                  ${BOLD}│${RESET}\n"
printf "${BOLD}  │${RESET}   Open:  ${BOLD}http://localhost:${HOST_PORT}${RESET}                  ${BOLD}│${RESET}\n"
printf "${BOLD}  │${RESET}                                                  ${BOLD}│${RESET}\n"

if [ "$CLAUDE_CODE_DETECTED" = true ] || [ "$CODEX_DETECTED" = true ]; then
  printf "${BOLD}  │${RESET}   LLM:   ${GREEN}Using your existing CLI subscription${RESET}  ${BOLD}│${RESET}\n"
elif [ "$OLLAMA_DETECTED" = true ]; then
  printf "${BOLD}  │${RESET}   LLM:   ${GREEN}Ollama (local)${RESET}                         ${BOLD}│${RESET}\n"
elif [ -n "$API_KEY_VAR" ]; then
  printf "${BOLD}  │${RESET}   LLM:   API key configured                     ${BOLD}│${RESET}\n"
else
  printf "${BOLD}  │${RESET}   LLM:   Configure in admin panel               ${BOLD}│${RESET}\n"
fi

printf "${BOLD}  │${RESET}                                                  ${BOLD}│${RESET}\n"
printf "${BOLD}  └──────────────────────────────────────────────────┘${RESET}\n"
echo ""
printf "  Next time, just run: ${BOLD}flight-finder${RESET}\n"
printf "  ${DIM}Ctrl+C to stop  |  flight-finder stop  |  flight-finder help${RESET}\n"
echo ""

# Open browser automatically (skip on headless systems or with --no-browser)
if [ "$FLIGHT_FINDER_OPEN_BROWSER" = "1" ]; then
  if [ "$(uname)" = "Darwin" ] && command -v open &>/dev/null; then
    open "http://localhost:${HOST_PORT}"
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:${HOST_PORT}" >/dev/null 2>&1 &
  fi
fi

# ---------------------------------------------------------------------------
# 11. Reachability — who can reach this instance? (consent-first; default none)
# ---------------------------------------------------------------------------
# Nothing here exposes the instance unless you explicitly pick it; the default
# and the non-interactive path keep it to this computer only. Installing the app
# on a phone home screen needs an https URL (service workers only run in a secure
# context); /connect shows the QR + add-to-home-screen steps.
printf "  ${BOLD}Who should be able to reach Flight Finder?${RESET}\n"
printf "    ${DIM}1)${RESET} This computer only            ${DIM}(default — nothing is exposed)${RESET}\n"
printf "    ${DIM}2)${RESET} Other devices on this network ${DIM}(prints the LAN URL; http only)${RESET}\n"
printf "    ${DIM}3)${RESET} A public URL via Cloudflare   ${DIM}(temporary tunnel, no account)${RESET}\n"
printf "    ${DIM}4)${RESET} Tailscale                     ${DIM}(private mesh; needs the Tailscale app)${RESET}\n"
printf "    ${DIM}5)${RESET} Skip / decide later\n"
echo ""

# Best-effort LAN IP for option 2.
lan_ip() {
  if [ "$OS" = "macos" ]; then
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

REACH_CHOICE="1"
if [ "${FLIGHT_FINDER_YES:-}" != "1" ]; then
  read -rp "  Choose [1-5, default 1]: " REACH_CHOICE < /dev/tty
fi
REACH_CHOICE="${REACH_CHOICE:-1}"

case "$REACH_CHOICE" in
  2)
    LAN_IP="$(lan_ip)"
    if [ -n "$LAN_IP" ]; then
      ok "On your network at: ${BOLD}http://${LAN_IP}:${HOST_PORT}${RESET}"
      printf "  ${DIM}Open that on a phone on the same WiFi. It is http, so the phone can view\n"
      printf "  it but cannot install it as an app — use option 3 or 4 for that.${RESET}\n"
    else
      warn "Could not determine your LAN IP — check your system network settings."
    fi
    ;;
  3)
    printf "  ${DIM}This opens a temporary ${RESET}${BOLD}public${RESET}${DIM} https URL to this machine. Anyone with\n"
    printf "  the URL can reach it; it goes away when you stop the tunnel.${RESET}\n"
    if command -v cloudflared &>/dev/null; then
      info "Starting a Cloudflare quick tunnel — copy the https URL, Ctrl+C to stop."
      cloudflared tunnel --url "http://localhost:${HOST_PORT}" || warn "Tunnel exited."
    else
      warn "cloudflared isn't installed."
      if [ "$OS" = "macos" ]; then
        printf "  ${DIM}Install it: ${RESET}${BOLD}brew install cloudflared${RESET}${DIM}, then:${RESET}\n"
      elif [ "$DISTRO_FAMILY" = "arch" ]; then
        printf "  ${DIM}Install it: ${RESET}${BOLD}sudo pacman -S cloudflared${RESET}${DIM}, then:${RESET}\n"
      else
        printf "  ${DIM}Install it (see ${RESET}${UNDERLINE}https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${RESET}${DIM}), then:${RESET}\n"
      fi
      printf "    ${BOLD}cloudflared tunnel --url http://localhost:${HOST_PORT}${RESET}\n"
    fi
    ;;
  4)
    printf "  ${DIM}Tailscale gives a private https URL on your tailnet (no public exposure).${RESET}\n"
    if command -v tailscale &>/dev/null; then
      printf "  ${DIM}Run:${RESET} ${BOLD}tailscale serve ${HOST_PORT}${RESET} ${DIM}(or ${RESET}${BOLD}tailscale funnel ${HOST_PORT}${RESET}${DIM} to expose publicly).${RESET}\n"
    else
      if [ "$OS" = "macos" ]; then
        printf "  ${DIM}Install Tailscale: ${RESET}${BOLD}brew install tailscale${RESET}${DIM} (and the app on your phone), then:${RESET}\n"
      else
        printf "  ${DIM}Install Tailscale: ${RESET}${BOLD}curl -fsSL https://tailscale.com/install.sh | sh${RESET}${DIM} (and the app on your phone), then:${RESET}\n"
      fi
      printf "    ${BOLD}tailscale serve ${HOST_PORT}${RESET}\n"
    fi
    ;;
  5)
    printf "  ${DIM}Skipped — set it up anytime.${RESET}\n"
    ;;
  *)
    printf "  ${DIM}This computer only. To reach it elsewhere later, re-run the installer.${RESET}\n"
    ;;
esac
echo ""
printf "  ${DIM}Phone steps + a QR code: ${RESET}${BOLD}http://localhost:${HOST_PORT}/connect${RESET}\n"
