# Changelog

## [0.5.2] - 2026-05-07

### Fixed
- **CLI `dc: invalid option -- 't'` on `fairtrail --headless`** (#64): `cmd_tui` used `exec dc exec ...` to dispatch the headless TUI, but bash's `exec` builtin only runs external commands and not shell functions, so it found `/usr/bin/dc` (GNU desk calculator) and passed it `-it web fairtrail-tui --headless`. The call site now expands `$_DC $COMPOSE_FILES` inline so the running shell is replaced by `docker compose` as intended. Regression test added.
- **"Best price found" card showed sold-out flights** (#64): `run-scrape` writes a `sold_out` snapshot that copies the prior price each time a flight disappears. PriceChart and PriceHistory both filter `status !== 'sold_out'`; BestPrice did not, so a vanished cheap fare could keep ranking as best with a Book button pointing at a dead listing. BestPrice now matches the other components and renders nothing when every snapshot is sold out.
- **Scraper failed for less popular EU airport pairs** (#65): `?q=one+way+flights+from+BDS+to+JFK+on+2026-11-09+to+2026-11-09` carried a redundant `+to+${dateTo}` for one-way searches and Google's NLU misparsed the duplicate date for less confident codes (BDS, BRI), falling back to the homepage. Retries hit the same URL three times. Fix rotates through three structurally distinct text URLs (verbose phrase, terse codes plus date, reworded with `departing`/`returning` keywords). New `pageHasRequestedRoute` defense verifies after navigation that the rendered page actually shows the requested route in the requested direction; `pageRedirectedToHomepage` catches the literal `q=` strip case. URL construction now goes through `URL`/`URLSearchParams` with strict IATA validation. Per-candidate logging tells operators which URL format Google's parser accepted. 12 commits, 10 `/codex` audit cycles.
- **Installer dead-ended on Manjaro/Arch when user freshly added to docker group** (#62 follow-up): `install.sh` ran `docker info &>/dev/null 2>&1` and treated any failure as "daemon not running", suggesting `sudo systemctl start docker` even when the daemon was already running and the actual error was permission denied on the socket. Now captures stderr, gates on exit status (not stderr presence, since docker info can exit 0 with deprecation warnings), and branches: permission-denied tells the user about the docker group and `newgrp docker`; daemon-down keeps the original `systemctl start docker` path.

## [0.5.1] - 2026-05-03

### Fixed
- **Installer now supports Arch and Manjaro**: `install.sh` detects Arch-family distros (arch, manjaro, endeavouros, garuda, artix, cachyos, plus anything with `ID_LIKE=arch`) from `/etc/os-release` and installs Docker via `pacman -Sy --needed --noconfirm docker docker-compose` followed by `systemctl enable --now docker.service`. Previously the unconditional `curl get.docker.com | sudo sh` path would fail because Docker upstream rejects Arch family in its convenience script (#62).
- **Origin airport preserved on edit**: editing a tracked query no longer drops the origin airport from the form (#60).

## [0.5.0] - 2026-05-01

### Added
- **Max trip duration filter**: AI parser now extracts duration caps phrased as "under 20 hours", "max 12h", "no more than Nh" and similar. Filtering runs server side after extraction, so it stays deterministic and provider agnostic. The manual entry form gains a matching "Max trip duration (hours)" input under Advanced options (#57).
- **Flight numbers in price history**: snapshots persist real flight identifiers (e.g. DL 345). The history table renders airline plus flight number so users can distinguish multiple flights from the same carrier. Sold out detection retains a transitional matcher that pairs new flightId synthesis with the legacy time only form, so existing rows are not flagged as disappeared on rollout (#57).
- **Ink terminal UI ships in the Docker image**: `fairtrail --headless`, `--list`, `--view <id>`, `--backend`, `--model` work after `curl install`. The bash wrapper forwards these flags to `fairtrail-tui` inside the running container with TTY auto detection. `--tmux` stays dev only because tmux pane spawning currently runs on the host shell and would not see the container cwd (#57).
- **Scrape interval can follow the global default**: per query `scrapeInterval` is now nullable. New trackers default to follow the admin global. Chart page exposes an "Auto" button alongside the fixed intervals; admin tables expose a "Follow global" option. Existing trackers keep their pinned numeric value (#57).
- Admin search page in the dashboard.
- `install.sh` accepts `--no-browser` for SSH and CI installs.

### Fixed
- Ink TUI no longer ships two React copies. tsup now externalizes all CLI runtime deps so Node resolves a single React (the one ink's react-reconciler also uses), unbreaking hooks (#57).
- Workspace local commander v13 is no longer clobbered by transitive root commander v2.20.3 inside the runner image (#57).
- Docker `deps` and `proddeps` stages now COPY `packages/cli/package.json` so `npm ci` installs CLI workspace dev deps including tsup (#57).
- Root `package.json` `ci` script also builds the `@fairtrail/cli` workspace, catching tsup misconfiguration locally instead of only inside Docker (#57).
- Stacked clarification dialog and component test infrastructure (#54).
- Per leg date validation for round trip clarifications (#54).
- Image references in compose files are fully qualified for Podman compatibility (#55).
- ClarificationCard submit handling and accessibility hardening.
- SearchBar preview session storage namespaced by surface so admin and public previews do not collide.
- All clarification answers are collected before the final submit.

## [0.4.3] - 2026-04-15

### Fixed
- Cron scheduler now reads scrape interval from the database instead of a hardcoded env var -- user-configured intervals from Settings UI are respected immediately (#50, reported by @garrynutter)
- `open` command gated behind Darwin check to prevent mime-type errors on Linux (#49)

### Added
- Tests for cron scheduler interval behavior (startup DB read, env var fallback, immediate reschedule on settings change)

## [0.4.2] - 2026-04-05

### Added
- **Server-wide theming**: new themes with persistence across instances
- **Preview run system**: flight search with status tracking, request hashing, and timeout management
- **Airport combobox**: searchable airport picker replaces manual code/city fields in the entry form
- **Admin default search method**: configure AI or manual as the default search mode
- **Multi-arch Docker builds**: GitHub Actions builds both amd64 + arm64 images

### Fixed
- Edit button on confirmation card no longer clears manually entered data (#46)
- Flexibility date range no longer double-expands on re-submit after editing
- Theme selection and persistence across instances
- Search method state management in SearchBar
- Em dashes replaced with hyphens in airport combobox display
- VPN prompt skipped in non-interactive mode (`FAIRTRAIL_YES=1`)
- Install script missing variables and TTY handling for VPN prompts

## [0.4.1] - 2026-03-31

### Added
- **Manual flight entry form**: bypass LLM parsing by entering airport codes, dates, and trip type directly (#37)
- Collapsible advanced options (flexibility, max price, stops, cabin class, time preference, currency, airlines)
- Custom select dropdown styling, focus-visible keyboard ring, mobile responsive layout

### Fixed
- Same-day round trips now rejected (API requires return after departure)
- Same origin and destination airport blocked in validation
- Date validation uses local timezone instead of UTC
- Stale error/clarification UI cleared when entering manual mode
- VPN country selections reset on search reset
- Anti-detection init script verification in tests
- Browser smoke test updated for settings page layout

## [0.4.0] - 2026-03-30

### Added
- **VPN Price Comparison**: scrape from multiple countries to test if VPN location affects flight prices. ExpressVPN via Docker sidecar (Linux) or macOS host bridge (Unix socket JSON-RPC)
- **Global Price Check** country picker on confirmation card with 20 countries and live VPN status
- **Chart country filter**: All / Country comparison / Local only / per-country views
- **Price History grouped by VPN country** with section headers and flag badges
- **Settings redesign**: grid-style provider cards, inline API key/token config, VPN provider grid with encrypted activation code
- **Currency dropdown** with 21 currencies + free text fallback
- **"Try a random flight"** button for quick onboarding
- **Notification sound** on search complete
- **Immediate scrape on query creation**
- Per-query `vpnCountries`, `docker-compose.vpn.yml`, `scripts/vpn-bridge.mjs`

### Fixed
- Admin `defaultCurrency` overrides browser locale in parse and preview
- Airline-direct falls back to Google Flights when blocked
- Chromium Docker Desktop compatibility
- Unified hover tooltip, time on X-axis

### Removed
- **Invite code system** removed (self-hosted only, no gating needed)

## [0.3.12] - 2026-03-29

### Added
- Fairtrail vs fli comparison in README: side-by-side table explaining why we use Playwright + LLM instead of Google's internal API
- Scraping constraints section in CLAUDE.md (rate limits, RT pricing, internal API reference)
- Docker images now built locally with pull-with-fallback, removing dependency on GHCR availability
- Native ARM64 Docker builds via ubuntu-24.04-arm runner

### Fixed
- `xxd` dependency removed from install script (not available on Raspberry Pi / ARM)
- OCI labels restored on per-platform Docker builds
- Round-trip price extraction prompt now explicitly notes Google shows combined RT prices

### Changed
- CI deploy and notify jobs removed; build workflow renamed to `build.yml`

## [0.3.11] - 2026-03-26

### Fixed
- Round-trip queries showing departure date as both departure and return date; `returnDate` was dropped from the preview-to-query pipeline ([#28](https://github.com/affromero/fairtrail/issues/28), reported by [@Fenisu](https://github.com/Fenisu))
- CLI (`fairtrail-cli`) also dropping `date` and `returnDate` when creating trackers from preview results
- Community sync dynamic import now resolves correctly in Docker production builds; removed `webpackIgnore` comment that caused module resolution to fail at runtime ([#27](https://github.com/affromero/fairtrail/pull/27), contributed by [@ms32035](https://github.com/ms32035))

## [0.3.10] - 2026-03-23

### Added
- Flight departure and arrival times in chart tooltips, price history table, best price card, and CSV export ([#21](https://github.com/affromero/fairtrail/issues/21), requested by [@jschwalbe](https://github.com/jschwalbe))
- Flight times exposed in the public prices API (`/api/queries/[id]/prices`)

### Fixed
- Chromium page crashes in Docker on Unraid and other platforms with restrictive IPC defaults; added `ipc: host` per Playwright recommendation ([#19](https://github.com/affromero/fairtrail/issues/19), reported by [@luciodaou](https://github.com/luciodaou))
- Shell scripts getting CRLF line endings on Windows clones, crashing `docker-entrypoint.sh`; added `.gitattributes` with `eol=lf` ([#22](https://github.com/affromero/fairtrail/issues/22), reported by [@luciodaou](https://github.com/luciodaou), PR [#23](https://github.com/affromero/fairtrail/pull/23))
- Playwright `networkidle` wait causing page crashes on memory-constrained hosts; switched to `domcontentloaded` ([#19](https://github.com/affromero/fairtrail/issues/19), reported by [@luciodaou](https://github.com/luciodaou))
- Duplicate sold-out snapshots created on every scrape run ([#18](https://github.com/affromero/fairtrail/issues/18), reported by [@Nanorithm](https://github.com/Nanorithm))

### Documentation
- Added related projects section to README

## [0.3.9] - 2026-03-20

### Added
- Podman support: installer and CLI detect Podman as a fallback when Docker is absent ([#13](https://github.com/affromero/fairtrail/issues/13))
- Podman networking: `host.containers.internal` for Ollama, conditional `extra_hosts` in generated compose
- Schema assertion test to prevent `bookingUrl` regression
- DELETE and PATCH endpoint tests covering hosted/self-hosted auth paths
- `run-scrape.ts` unit tests (previously untested)

### Fixed
- Flight tracking crash when LLM returns null `bookingUrl` ([#14](https://github.com/affromero/fairtrail/issues/14))
- Delete button invisible on touch devices and after browser/server reinstall ([#8](https://github.com/affromero/fairtrail/issues/8))
- Self-hosted users unable to delete or update trackers without original session token
- Null booking URLs causing crashes in BestPrice, PriceCalendar, PriceHistory components

## [0.3.8] - 2026-03-18

### Added
- Currency and country fields on the self-hosted settings page (matching admin config)
- Health check for local providers (Ollama, llama.cpp, vLLM) before marking as "ready"
- `'unreachable'` status in providers API for local providers that don't respond
- Docker Compose integration test suite (17 checks against live app + DB + Redis)
- Playwright browser smoke tests (10 checks: pages, inputs, navigation, static assets)
- Debian Docker end-to-end installer test (17 checks in real Debian container)
- Staging test that runs on the production server (22 checks via SSH)
- Vitest and shell tests now run in CI on every PR
- Volume migration safety tests (project name match, no `down -v`)
- `FAIRTRAIL_SKIP_START` and `FAIRTRAIL_SKIP_PULL` install.sh overrides for test automation
- Non-interactive mode (`FAIRTRAIL_YES=1`) skips API key prompt

### Fixed
- `fairtrail update` hardcoded `~/.local/bin/fairtrail` instead of detecting the actual binary path ([#8](https://github.com/affromero/fairtrail/issues/8))
- `fairtrail update` swallowed curl errors with `2>/dev/null`
- CLI not in PATH on Debian SSH sessions (installer patched `.bashrc` but not `.profile`)
- Old `~/fairtrail` directories left behind after migration to `~/.fairtrail`
- Ollama, llama.cpp, and vLLM shown as "ready" even when unreachable
- `HOST_PORT` vs `PORT` confusion in generated `.env` (now documented with warning in entrypoint)

## [0.3.7] - 2026-03-17

### Added
- vLLM as first-class local provider (GPU-accelerated inference, default port 8000)
- Dynamic model discovery for vLLM via `/v1/models` endpoint
- vLLM listed in README, landing page, and CLAUDE.md

### Changed
- Refactored `fetchLlamacppModels` into shared `fetchOpenAICompatModels` (reused by llamacpp and vLLM)

## [0.3.6] - 2026-03-17

### Added
- Dynamic model discovery for Ollama and llama.cpp. Config pages now fetch installed models from the local instance and show them in a dropdown instead of an empty select ([#9](https://github.com/affromero/fairtrail/issues/9))
- New `/api/admin/local-models` endpoint with Redis caching (5min TTL) for querying Ollama `/api/tags` and llama.cpp `/v1/models`
- Installer now detects Ollama running locally, lists available models, and writes Docker-compatible `OLLAMA_HOST` (`host.docker.internal`)
- `extra_hosts` for `host.docker.internal` in Docker Compose so containers can reach host-local services on Linux

### Fixed
- Empty model dropdown when selecting Ollama or llama.cpp in admin config, settings, and setup pages
- Installer no longer requires a paid API key when Ollama is available
- Ollama API `parameter_size` read from `details.parameter_size` (not top-level), fixing incorrect model size display
- Race condition in setup wizard where async model fetch could overwrite user-typed model ID
- Client-side validation prevents saving with an empty model ID
- Stale model list no longer shown alongside "Fetching models..." during provider switch

## [0.3.5] - 2026-03-17

### Added
- First-class Ollama and llama.cpp providers — select from the admin UI dropdown, type your model ID, and optionally set a custom base URL. No env vars needed ([#8](https://github.com/affromero/fairtrail/issues/8), thanks [@johenkel](https://github.com/johenkel))
- DB-persisted `customBaseUrl` field on ExtractionConfig — configure LLM endpoints from the admin UI instead of requiring server-side env vars
- Base URL input in admin config, settings, and setup pages with auto-populated defaults per provider

### Fixed
- Installer and CLI now support both `docker compose` (v2 plugin) and `docker-compose` (v1 standalone) — fixes install failure on Docker 20.x systems ([#8](https://github.com/affromero/fairtrail/issues/8), thanks [@johenkel](https://github.com/johenkel))

## [0.3.4] - 2026-03-16

### Fixed
- Complete `HOST_PORT` migration — CLI wrapper and Node CLI now respect `HOST_PORT`/`FAIRTRAIL_URL` env vars instead of hardcoded `localhost:3003`
- Setup route password hash mismatch — was storing SHA-256 but login expects scrypt; setup passwords now hash correctly
- API-created query trackers no longer garbage-collected by stale cleanup — `firstViewedAt` is set on creation
- Preview cache key now includes cabin class, trip type, and currency — prevents stale cached results across different search parameters
- Multi-date round-trip preview pairs outbound/return dates by index instead of using only the first return date
- Concurrent scrape runs blocked by process-level mutex — duplicate cron + manual triggers return 409 instead of duplicating snapshots
- Removed `--accept-data-loss` from `prisma db push` in entrypoint and deploy workflow — destructive schema changes now require manual intervention

## [0.3.3] - 2026-03-15

### Fixed
- `PORT` env var leaking into Docker container is now fully resolved — entrypoint hardcodes internal port to 3003 regardless of env_file contents, so custom compose files no longer need a `PORT: "3003"` override ([#4](https://github.com/affromero/fairtrail/issues/4))
- Renamed user-facing `PORT` env var to `HOST_PORT` to eliminate ambiguity between host mapping and container bind port

### Documentation
- Added local model provider (Ollama, llama.cpp, vLLM) to README LLM table and quick start
- Consolidated README configuration tables

## [0.3.2] - 2026-03-14

### Added
- Custom OpenAI-compatible endpoints via `OPENAI_BASE_URL` — run local models (Ollama, llama.cpp, vLLM) or alternative providers (OpenRouter) with any model ID ([#7](https://github.com/affromero/fairtrail/issues/7))
- Local endpoints work without an API key — no `OPENAI_API_KEY` needed when `OPENAI_BASE_URL` is set

### Fixed
- Codex CLI auth failure in Docker containers — permission-denied errors on host `~/.codex` mount are now reported clearly instead of failing silently with 401 ([#1](https://github.com/affromero/fairtrail/issues/1))
- CLI providers (codex, claude-code) are only shown as available when auth is actually configured, preventing users from selecting an unauthenticated provider
- Claude Code entrypoint copy now uses permission-aware logic with actionable error messages (same fix as codex)
- Benign "could not update PATH" warnings stripped from CLI error output; 401 errors include an auth hint
- Container PORT env var no longer leaks into the app ([#4](https://github.com/affromero/fairtrail/issues/4))

### Changed
- Removed `CODEX_ENABLED` / `CLAUDE_CODE_ENABLED` env vars — CLI providers are auto-detected by binary presence + auth file checks
- Removed auth.json generation from entrypoint — API key users use SDK providers directly; CLI providers are for subscription users who mount host auth dirs
- CLI auth copy and install wrapped in `SELF_HOSTED` guard to skip on production server (~15s startup savings)

## [0.3.1] - 2026-03-14

### Added
- `--backend` and `--model` CLI flags to select AI provider per session
- Multi-destination parsing: "Bogota or Medellin" creates separate route searches
- CLI demo GIF and Headless CLI section in README

### Fixed
- Multi-route flight selection now tracks all routes (via `_routeIdx` tagging)
- `--tmux` inside tmux splits into new panes instead of sending to own running pane
- `--tmux` works with single-route queries (no split, just view)
- Chart flicker eliminated by memoizing expensive renders (countdown ticks don't redraw chart)
- CLI providers (claude-code, codex) no longer require API key env vars
- Commander import fixed for Linux CI typecheck
- Docker PORT env var no longer leaks into container

## [0.3.0] - 2026-03-13

### Added
- **Headless CLI TUI** (`--headless`) — full terminal interface for flight price tracking using Ink 6 (React for terminals)
  - Interactive search wizard: natural language query, LLM parse, Playwright scrape, flight selection, DB tracking
  - `--headless --list` — navigable table of all tracked queries with status, prices, last scraped time
  - `--headless --view <id>` — live price chart with Unicode braille rendering, auto-refresh every 30s with countdown bar, per-airline colored trend lines
  - `--headless --view <id> --tmux` — opens isolated tmux session in new Ghostty window with one pane per grouped route
- **`packages/cli/` workspace** — new monorepo package sharing scraper libs from `apps/web/` via custom Node.js ESM alias loader
- **Braille chart renderer** — Unicode braille characters (2x4 dot grid) with Bresenham line drawing, dynamic Y-axis scaling, rolling time window
- Without `--headless`, `--view` opens the web browser and `--list` opens the admin dashboard
- 28 unit tests for chart renderer and formatters, plus E2E test script

### Fixed
- Chart dynamically adapts to tmux pane dimensions on resize

### Changed
- Root `npm run cli` now implies `--headless` for terminal usage
- CI lint and typecheck now include the CLI workspace

## [0.2.3] - 2026-03-13

### Fixed
- Codex CLI `--print` error — codex does not support `--print` (Claude Code flag); now uses `codex exec` for non-interactive extraction ([#1](https://github.com/affromero/fairtrail/issues/1) — thanks @bobvmierlo)
- CLI checksum verification removed — was blocking installs when the CLI script changed between releases
- Both Claude Code and Codex CLIs now install unconditionally in the container (no env var gating needed)
- Telegram deploy notifications no longer fire on cancelled CI runs

### Changed
- README updated: full CLI help output, explains why `~/.claude` and `~/.codex` are mounted read-only, CLI providers show as auto-detected

## [0.2.2] - 2026-03-13

### Fixed
- `fairtrail: command not found` on Ubuntu — installer now auto-patches shell profile to add `~/.local/bin` to PATH ([#1](https://github.com/affromero/fairtrail/issues/1) — thanks @bobvmierlo)
- `spawn codex ENOENT` in Docker — entrypoint installs CLI providers (codex, claude) inside the container when enabled, persisted via `cli-cache` volume ([#1](https://github.com/affromero/fairtrail/issues/1))
- `xdg-open` error spam on headless Linux — guarded behind `DISPLAY`/`WAYLAND_DISPLAY` check ([#1](https://github.com/affromero/fairtrail/issues/1))
- Install one-liner changed from `| sh` to `| bash` — the script uses bash-specific syntax that breaks under dash (Ubuntu default `sh`)
- Codex CLI spawn now passes `env` to child process (was missing, unlike claude-code)
- Actionable ENOENT error messages for CLI providers instead of raw stack traces

### Added
- Tests for CLI provider detection, ENOENT handling, and installer shell script correctness (18 new tests)

## [0.2.1] - 2026-03-09

### Added
- "What Fairtrail is not" section on landing page
- System theme detection with demo GIF swap for light/dark modes
- Behavioral test suite (110 tests across 14 files)
- Cron scheduling jitter (±2.5min) to avoid bot detection

### Fixed
- Docker multi-arch manifest so `fairtrail update` works on Apple Silicon (arm64)
- Docker image slimmed from 1GB to 475MB
- Pin Prisma@6 in entrypoint and deploy to avoid v7 breaking changes
- POSIX shell compatibility for installer (replace `echo -e` with `printf`)
- Mount `~/.claude.json` config in installer for Claude Code CLI users

### Changed
- CI cancels in-progress deploys when a new push arrives

## [0.2.0] - 2026-03-08

### Added
- OS detection in installer with Docker install guidance for Linux and WSL
- Port conflict check during install with interactive port selection
- Browser auto-open when starting Fairtrail via CLI
- `fairtrail version` command showing version and git commit SHA
- Commit SHA exposed in `/api/version` endpoint for build traceability
- "Why self-hosted?" section on landing page
- PNG favicon and Apple touch icon for cross-browser support

### Changed
- Self-hosted instances skip admin password setup — go straight to provider selection
- Install script shows security-relevant commands before executing

## [0.1.0] - 2026-03-08

### Added
- Natural language flight search powered by LLM (Anthropic, OpenAI, Google AI)
- Automated price tracking via Google Flights scraping (Playwright + headless Chromium)
- Interactive Plotly.js price evolution charts with airline colors and click-to-book
- Self-hosted Docker installer (`curl -fsSL https://fairtrail.org/install.sh | sh`)
- `fairtrail` CLI for managing self-hosted instances (start, stop, logs, search)
- Multi-currency support with locale auto-detection
- Multiple travel date support with date grouping in charts
- Price drop alerts on home page
- Share links, CSV export, and price calendar on chart pages
- Community route sharing between self-hosted instances
- Explore page with seed routes and popular destinations
- Admin dashboard with query management, LLM config, and cost tracking
- PWA support with auto-update banner
- Configurable scrape interval (default 3h)
- GitHub Actions CI/CD with Docker image publishing to GHCR
