# Changelog

## [0.13.0] - 2026-07-10

Editable trackers, honest prices in every currency, and provider keys managed from the admin UI.

### Added
* **Edit a running tracker in place.** Dates, stops, airlines, cabin, and price cap can be changed on an active tracker without deleting and recreating it, and the chart marks when the filters changed so price history stays interpretable. (requested by @garrynutter)
* **Provider API keys from the admin UI.** Anthropic, OpenAI, and Google keys can be set in the admin config or the setup wizard and are stored encrypted at rest, so a key change no longer requires editing env files and restarting. (reported by @Relaxdaws)
* Desktop app: a Restart action that recreates the stack and a visible path to the config file. (#151)

### Fixed
* **Prices now format correctly in every currency.** One Intl based formatter replaces the manual symbol table and six ad hoc code paths: ISO codes instead of the ambiguous `$`, correct grouping and decimals in each currency's own locale (a Colombian fare reads `COP 228.290`, not `$228,290`), applied across the app, notifications, community pages, and the chart. Thanks @ssantss.
* High denomination fares (COP, JPY, VND) are no longer rejected by a price cap tuned for dollars, across search, ingest, preview, and the scraper. Thanks @ssantss.
* Currency detection now resolves every browser locale through Intl instead of a partial region table, so regional and macro locales map to a real currency. Thanks @ssantss.
* Follow ups to the 0.12.0 extraction report (reported by @Darth-Ness): Docker images ship `browsers.json` so the scraper can always launch Chromium, `OLLAMA_HOST` is respected inside Docker instead of being forced to localhost, extraction tolerates misspelled or aliased model output keys, and installs from before the project rename are prompted to migrate instead of silently freezing.

### Changed
* Dependency updates across web, desktop (Tauri 2.11.5), and CI actions.

## [0.12.0] - 2026-06-13

Reliable price extraction across every model, a platform refresh (Next.js 16, Prisma 7), and clearer bug reports.

### Fixed
* **Searches no longer all end in "Flights exist but none matched your filters."** The extractor compared each price exactly as the model returned it, so a model that wrote the price as a string with a currency symbol or a thousands separator ("$189", "1,189") had every row thrown out and the whole search collapsed. Prices are now read from any common format (currency symbols, and both US and EU grouping and decimals), the JSON reader copes with reasoning blocks, code fences, wrapper objects, and stray text around the array, and a row is dropped only when it truly has no price or airline. This mostly affected smaller and local models. (reported by @Darth-Ness)
* The Claude Code extraction provider no longer inherits a stray `ANTHROPIC_BASE_URL` or auth token from the host, which could quietly point it at the wrong endpoint and fail every extraction.

### Changed
* **Platform upgrade.** Next.js 16, Prisma 7 (a lighter, Rust-free database client), TypeScript 6, ESLint 10, Vitest 4.1, Plotly 3, and a Node 26 base image, with dependency updates now grouped per ecosystem and given a cooldown before they land.
* The app uses the real Flight Finder logo for its icons, favicon, and on-page brand mark.

### Added
* Structured GitHub issue forms for bug reports and feature requests, so a report carries the version, deployment, provider, model, and logs needed to reproduce it.
* Secret scanning in CI to catch accidentally committed credentials.

## [0.11.0] - 2026-06-10

Install Flight Finder without ever touching a terminal, and run it for a whole household: a native desktop app, passwordless profiles like Netflix, a personal theme per person, and a guided way to reach it from a phone.

### Added
* **No-terminal desktop app.** A native launcher (macOS `.dmg`, Windows `.exe`, Linux `.AppImage`) that, on first run, either runs the stack on this computer (Host mode) or connects to an existing instance (Client mode), each in its own window. Installers build automatically on every published release and are linked from a new `/download` page.
* **Households without passwords.** In multi user mode a member can be passwordless: the login screen becomes a "Who's using Flight Finder?" picker where each person taps their face to sign in, Netflix style, and guests can be quick-added with generic names. Each member keeps their own trackers, a flight-themed profile avatar, and preferences.
* **Personal theme families.** Six colour families (Altitude, Midnight, Cyberpunk, Tron, Autumn, Solar), each with a matching light and dark palette. Pick a family once and the light/dark toggle flips within it; members keep a personal theme while admins set the instance default.
* **Reach it from a phone, guided.** An interactive guide in Instance settings (same Wi-Fi, Tailscale, Cloudflare quick and named tunnels, or your own domain) walks the OS-specific commands, and `/connect` shows a QR code carrying the member avatar plus native share buttons. The installer offers a consent-first reachability choice that defaults to no exposure.
* **Unified navigation.** One avatar menu on every page (your trackers, account & appearance, connect a device, and admin destinations) plus a persistent Flight Finder home logo, replacing the old per-page button toolbars.
* **Admin toggle for accepting community registrations.** The hub-side control that lets other instances register to contribute their data is now an admin toggle in Settings (default off, opt-in), next to a clearer explainer of why to enable Community Data Sharing. The `COMMUNITY_REGISTRATION_OPEN` env var still works as an override.
* Flight-themed profile avatars (generated art with an emoji fallback), maskable PWA icons for a proper Android home-screen install, and OS-aware hints for any tool you need to install.

### Fixed
* Fresh self-hosted instances now show the setup wizard again: setup-complete keys on whether an admin password has been set, not on the provider column's NOT NULL default.
* The session cookie's `Secure` flag now follows the actual request protocol instead of `NODE_ENV`, so Safari can sign in over `http://localhost` or a LAN IP (a Secure cookie was silently dropped there, bouncing every request back to `/login`).
* The service worker no longer caches the HTML shell, so a redeploy is picked up on the next load instead of serving a stale page.
* Instance settings now renders dynamically, so a member's personal theme is correct on that page too rather than showing a statically-baked default.
* Notification and VPN channel secrets encrypted before v0.10.0 now decrypt after upgrading, via a backward-compatible key-derivation fallback, so upgrading no longer requires re-entering them. They are re-encrypted under the stronger derivation the next time they are saved.

## [0.10.0] - 2026-06-05

This release adds new-low price alerts with pluggable notification channels, CLI account recovery for multi user mode, and the full results of a security audit and remediation (PR #109).

### Security
* **Full security audit remediation** (PR #109). Fixed a stored XSS on the public share and landing pages (unescaped JSON-LD). Hardened admin and user sessions with server-side token expiry, revocation on password change, and constant-time secret comparisons. Centralized client IP extraction so the login, parse, preview, and community rate limits can no longer be bypassed by spoofing `X-Forwarded-For`. Closed SSRF holes in notification channels: per-user webhook, ntfy, and SMTP targets are validated, resolved and pinned against DNS rebinding, and redirects are rejected. Locked down the agentic CLI extraction providers (Claude Code, Codex) so a prompt injection in a scraped page cannot run commands or read host files, and now sanitize and fence all scraped HTML as untrusted data for every provider. Bounded previously unbounded endpoints, gated `/api/alerts` and the analytics write endpoint, added a Content Security Policy and other security headers, and removed stray state and secrets from the git tree and the Docker build context.

### Added
* **New-low price alerts and notification channels** (#106): get notified when a tracked flight reaches a new low. Pluggable channels for Telegram, email, ntfy, and webhooks, managed from a new admin GUI, with configurable absolute and percentage drop thresholds. Also adds a pause/resume scraping toggle, GUI-configurable provider rate limits and preview limits, self-service password change, and a button to disable multi user mode. Reported by @garrynutter.
* **CLI account recovery for multi user mode** (#102): two recovery commands for a self hosted admin who is locked out. `flight-finder reset-password <username> <new-password>` sets a known password for any user; `flight-finder disable-accounts` turns multi user mode off and clears the stored admin credential, dropping the instance back to solo self hosted mode where no login is required. Both run inside the web container against the live database. Reported by @garrynutter.
* Ko-fi support links.

### Changed
* Community price-sharing registration is now OFF by default. Set `COMMUNITY_REGISTRATION_OPEN=true` to allow public key registration.
* Scrape timestamps now render in each viewer's own local timezone.
* Self-hosted instances use the global server theme, and the public tracker page is forced dynamic so theme and prices stay fresh (#89). Reported by @antoniods97.

### Fixed
* Analytics history now persists across container recreates instead of resetting.
* The price history table and other timestamp displays no longer trigger a client hydration mismatch.

### Upgrade notes
* The database schema gained `ExtractionConfig.adminSessionsValidFrom`; `prisma db push` runs on deploy.
* Notification and VPN channel secrets are now encrypted with a stronger key derivation, so existing secrets must be re-entered once after upgrading.
* New env var `TRUSTED_FORWARDED_FOR`: set it to `false` if the app is not behind a trusted reverse proxy (the default trusts the proxy, which is correct behind the bundled Caddy).

## [0.9.5] - 2026-06-02

### Fixed
* **CLI header box alignment and brand** (#96): the terminal header drew its own border and padded a line by hand, so the right edge drifted out of column, and it still showed the pre rename FAIRTRAIL brand. It now renders on a self sizing box that stays aligned and reads FLIGHT FINDER. Reported by @backslashV.

### Changed
* **Remaining CLI brand strings now read `flightfinder`** (#96): the leftover `fairtrail` references in user facing CLI output (the usage hints, the tmux pane command, the version line) were swept to `flightfinder`. The deprecated `fairtrail` command still works as an alias.

## [0.9.4] - 2026-06-01

### Added
* **Price history grouped by flight** (#89): the tracker page (`/q/[id]`) now collapses its history into one row per flight, showing the latest price, change, seats and book link, cheapest first, with each flight's full series one click away. After a week of scraping the table stays readable instead of growing into a flat wall of every snapshot. Reported by @antoniods97.
* **Configurable max tracked flights per route** (#89): new `maxTrackedPerRoute` setting in `/admin/config` (default 10, range 1-50) drives how many flights you can select to track per route, replacing the hardcoded 10. It is still bounded by Max flights per date, since you can only pick from the flights that were extracted.
* **Trackers expire once their departure day has passed** (#96): a tracker whose travel date is in the past stops scraping automatically instead of running forever. Reported by @backslashV.
* **CLI `--json` output and headless polish** (#96): `flightfinder --json` emits a single tracker or the full list as JSON, and the headless view header now shows airport codes.

### Fixed
* **App defaults to self-hosted** (#89): the per-tracker edit controls hid on any browser without a delete token because the entrypoint never exported `SELF_HOSTED`, so a stack that omitted the variable ran in hosted mode. A migrated tracker that lost its localStorage token lost its controls. The image now defaults to self-hosted and flight-finder.org is the only deployment that opts into hosted mode; CLI provider install moved to its own `INSTALL_CLI_PROVIDERS` flag so production behavior is unchanged. Reported by @antoniods97.
* **Offline Prisma schema push** (#96): the runtime image bundles the Prisma CLI instead of fetching it with `npx` at startup, so the schema push works without round-tripping the npm registry and a failed push halts startup instead of masking the error behind a misleading "Schema ready".
* **CLI booking URL no longer truncated** (#96): the best price card was rebuilt so it stops cutting off the booking link, and the CLI package now ships its `package.json` so Node resolves the module type.

## [0.9.3] - 2026-05-29

### Fixed
* **Chart hover box no longer overlaps the axis labels** (#97): on the price chart the unified hover box inherited the transparent `paper_bgcolor`, so the x axis date ticks bled through it into unreadable text-on-text when hovering a point low on the plot. The hover label now has an explicit opaque surface, border, and font, so it cleanly occludes whatever sits behind it. (This is the browser chart on `/q/[id]`, not the terminal TUI.)
* **`flightfinder` TUI flags broke when `podman compose` delegates to `podman-compose`** (#96): on Fedora `podman compose` is a thin wrapper around the standalone `podman-compose` provider, which rejects the `-it`/`-i` exec flags, so `flightfinder --list` and `flightfinder --headless` aborted with `unrecognized arguments: -it`. Detection treated a successful `podman compose version` as a native, docker compatible engine and sent `-it`. It now inspects the version output (the external provider banner on stderr and the `podman-compose version` line on stdout) and, when `podman-compose` is the active provider, drives it directly so the existing helper selects `-T`/empty. A new `podman_delegated` runtime in `cli-runtime-test.sh` mirrors podman's external provider banner and asserts exec routes through `podman-compose` with `-T`, never through the wrapper with `-it`.

## [0.9.2] - 2026-05-28

### Added
* **Configurable preview combination cap** (#89): new `previewMaxCombos` setting in `/admin/config` (default 24, range 6-96) bounds the routes x dates fan-out of the create-time preview scrape only. Wide multi-airport flex searches that exceeded the old hardcoded 24 can now be created by raising the cap; the recurring cron always covers the full grid.

### Fixed
* **Per-tracker edit controls now appear without a local delete token** (#89): the label, aggregator picker, and scrape interval controls were gated on the browser's localStorage token, so they vanished on a tracker whose token was lost (e.g. after a machine migration) even though the backend would accept the edit. They now render whenever the server already authorizes the change (self hosted solo, admin, or owner).
* **Theme no longer flashes the default on tracker pages** (#89): the saved Dark/Light choice is applied by an inline head script before first paint, so `/q/[id]` and other cold renders stop briefly reverting to the default theme.

## [0.9.1] - 2026-05-27

### Added
* **Per-tracker aggregator override** (#89): new AggregatorPicker component on each tracker detail page lets users toggle which scrape sources to use per tracker. Shared aggregator constants extracted to `lib/aggregators.ts`.
* **Custom tracker label** (#89): optional free-text label (max 60 chars) on trackers, editable inline on the detail page. Labels surface in the dashboard card list and admin queries page so duplicate trackers for the same route are distinguishable.
* **Configurable max flights per date** (#92): new `maxFlightsPerDate` setting in `/admin/config` (default 10, range 5-50). Busy routes with 30+ daily flights can raise the cap to capture afternoon and budget options the LLM was previously cutting off.

### Fixed
* Dynamic route detail page no longer 404s on card navigation.
* Theme toggle persists locally when `/api/admin/config` requires auth.

## [0.9.0] - 2026-05-26 Renamed to Flight Finder

### Renamed
* **The project is now Flight Finder.** Brand, domain, GitHub repo, npm workspace, Doppler project, install dir, database, binary, and image all carry the new name. The old fairtrail.org domain 301 redirects to flight-finder.org with the path preserved, the GitHub repo auto redirects from affromero/fairtrail, and historical ghcr.io/affromero/fairtrail tags stay pullable.

### Added
* **Automatic migration for self hosted installs.** `fairtrail update` (or the new `flight-finder migrate` subcommand) detects `~/.fairtrail`, runs `ALTER DATABASE fairtrail RENAME TO flight_finder` against the existing postgres container, moves the directory to `~/.flight-finder`, and writes a marker file so the regenerated compose keeps `name: fairtrail` at the top. That preserves the existing fairtrail_pgdata, redisdata, app-data, and cli-cache named volumes without a data copy. Idempotent and safe to re-run. See [MIGRATION.md](MIGRATION.md) for the full story.
* **Deprecated fairtrail binary alias.** The installer keeps `~/.local/bin/fairtrail` working as a symlink to the new wrapper through v1.0. Invocations under the old name print a one line deprecation notice (silenceable via `FLIGHT_FINDER_SILENCE_RENAME=1`).
* **In app rename banner.** The version endpoint returns a `renameAnnouncement` object for clients on a version below 0.9.0; the dashboard renders a distinct cyan accented banner with the upgrade command and a dismiss button that persists per latest version in localStorage.
* **Pinned README migration section and MIGRATION.md** linked from CHANGELOG and the in app banner.

### Changed
* Env var prefix `FAIRTRAIL_*` becomes `FLIGHT_FINDER_*` everywhere (install.sh, the CLI wrapper, dev scripts, AGENTS docs). No backward compat aliases.
* npm workspace slugs `@fairtrail/web` and `@fairtrail/cli` become `@flight-finder/web` and `@flight-finder/cli`. Internal only; nothing publishes to the registry.
* CLI binary canonical name is `flight-finder` with `flightfinder` as a single word alias symlink and `fairtrail` as the deprecated alias.
* Postgres database renamed from `fairtrail` to `flight_finder` in every compose template plus the production deploy.
* Container image `ghcr.io/affromero/fairtrail` becomes `ghcr.io/affromero/flight-finder` going forward.
* localStorage and cookie keys keep the `ft-` prefix (`ft-trackers`, `ft-session`, `ft-backfill-*`, `ft-preview-run`) so existing browsers preserve their state. The `ft` initials happen to fit both old and new names.
* Service worker cache key bumped from `fairtrail-v1` to `flight-finder-v1` so existing browsers purge the old shell on first load post cutover.

### Infrastructure
* `scripts/migration-test.sh` joins the pre-release gate as the fourth required check. Static grep assertions over install.sh and the wrapper cover the migration block, marker handling, deprecated alias, deprecation notice, and migrate subcommand dispatch.
* `vitest.config.ts` adds an `oxc.jsx` setting alongside the existing esbuild option since vitest 4 transforms with oxc and silently ignored the esbuild config.

## [0.8.0] - 2026-05-26

### Added
* **Skyscanner and Kayak as fallback aggregators** (#89): the price scrape now walks an ordered chain of sources per query instead of falling back to Google Flights as a single hardcoded branch. New `navigateSkyscanner` and `navigateKayak` follow the same `NavigationResult` shape as `navigateAirlineDirect`, gate the result via `hasFlightPriceSignal`, and dismiss the usual Cloudflare and consent dialogs. Both ship behind feature flags and are off by default: admin enables them in `/admin/config` via the new `ExtractionConfig.aggregatorsEnabled` allowlist, users then order them in `/account/settings`. Skyscanner and Kayak both deploy aggressive anti-bot (Cloudflare, PerimeterX), so v1 reliability is best effort -- 40 to 70 percent in burst, dropping under sustained load. Residential proxies or paid CAPTCHA solving would unlock production grade reliability and are out of scope.
* **Per user and per query aggregator preference** (#89): `User.preferredAggregators` carries the user default; `Query.preferredAggregators` overrides per tracker. The chain resolver precedence is per query > per user > admin allowlist order. The new `SettingsForm` aggregator section renders an ordered checklist with up and down buttons; Skyscanner and Kayak rows visibly tag `experimental` and are disabled when admin has not enabled them. `/api/queries/[id]` PATCH accepts `preferredAggregators` with single id scope (no group cascade, unlike `scrapeInterval` and `active`); `/api/admin/queries/[id]` PATCH has parity. `/api/account/settings` returns the new field on GET and validates it with HTTP 422 on PATCH.
* **Manual scrape completion summary log** (#89): the background IIFE in `/api/queries/[id]/scrape` now emits `[scrape] manual run complete (group=<id>): N successes, M failures` once every target finishes, matching the cron summary format. A target counts as success only when every country pass landed prices; thrown targets and empty results both count as failure.

### Schema
* New columns auto-applied via `prisma db push` on deploy. Defaults mean existing rows are unaffected.
  * `User.preferredAggregators String[] @default([])`
  * `Query.preferredAggregators String[] @default([])`
  * `ExtractionConfig.aggregatorsEnabled String[] @default(["google_flights", "airline_direct"])`
* `FetchRun.source` doc comment widened to document joined source labels (e.g. `google_flights+skyscanner`).

### Changed
* `scrapeOneDatePair` now drives the aggregator chain at the top of the attempt loop instead of only inside the airline_direct diversification branch. Skyscanner and Kayak are now reachable for every query, not just queries with airline preferences. The issue-65 invariant is preserved: `all_filtered_out` short circuits the chain (real flights existed; filters excluded them); per-aggregator throws are caught so the next source can still be tried; airline_direct stub pages still divert to the next chain entry inside the same attempt.
* `extract-prices.ts buildSystemPrompt` source labels and bookingUrl rules converted from ternaries to switches with explicit cases for `skyscanner` and `kayak`.
* `runScrapeForQuery` query lookup now includes the owning user via `include: { user: { select: { preferredAggregators: true } } }` so per user prefs are available in the resolver. Anonymous and seed queries (where `userId` is null) fall through to admin allowlist order.

## [0.7.4] - 2026-05-25

### Added
* **Admin UI setting for LLM extraction timeout** (#86): when 90s is too short for slow CPU bound local models (issue #84 follow up, originally surfaced by a Manjaro user on `qwen3:0.6b`), admins can now extend the per call abort from `/admin/config`. New `extractTimeoutSeconds Int @default(90)` column on `ExtractionConfig` (range 30 to 600, enforced server side with `Math.max(30, Math.min(600, Math.round(...)))` plus a `Number.isFinite` guard so a cleared number input does not crash Prisma). `ai-registry.ts` exposes `timeoutMs?: number` on `ExtractOptions`; every SDK provider (anthropic, openai, ollama, llamacpp, vllm, google) now reads `options?.timeoutMs ?? EXTRACT_TIMEOUT_MS` for `AbortSignal.timeout`. parse-query and extract-prices fetch `extractTimeoutSeconds` off the singleton config row per call, so a settings change applies on the next parse with no container restart. The `EXTRACT_TIMEOUT_MS` env var stays as the ops fallback when the column is unset. CLI providers (claude-code, codex) keep their existing spawn timeout, separate scope. Co-authored with [@Darth-Ness](https://github.com/Darth-Ness), who opened PR #87 with the schema column and PATCH handler skeleton.

### Changed
* `ExtractionConfigOverride.extractTimeoutSeconds` is optional (`?: number | null`) so the existing preview-runner caller compiles without forwarding the field, and is plumbed through `ExtractionContext` in `preview-runner.ts` so a 20 route preview honours the configured timeout for every route.
* Admin config number input step is `1` rather than `10`, matching the actual server accepted range (any integer 30 to 600).

## [0.7.3] - 2026-05-22

### Fixed
* **Ollama search returned `404 404 page not found` from `/api/parse`** (#84): a saved `customBaseUrl` without the `/v1` suffix (e.g. `http://host.docker.internal:11434`) sent the OpenAI SDK to `<host>/chat/completions`, which Ollama answers with its catchall 404. The SDK rewrapped the response as `404 404 page not found` (status + body) and `/api/parse` surfaced it inside a 422 envelope, while model discovery kept working because the `local-models` route already strips a trailing `/v1` before calling Ollama native `/api/tags`. New `ensureV1Suffix()` helper in `ai-registry.ts` normalises the URL for every local provider (ollama, llamacpp, vllm), and the `OLLAMA_HOST` env path was simplified to the bare host and routed through the same helper. 11 new regression tests cover idempotency, trailing slash, `host.docker.internal` style addresses, env var only, and the bare fallback.
* **`Failed to parse LLM response as JSON` on local providers** (#84 follow up): small Ollama models occasionally returned prose, partial markdown, or a refusal that contained no `{...}` block, so the parser regex bailed with no logging at all. parse-query now opts into OpenAI's `response_format: { type: 'json_object' }` via a new `responseFormat?: 'json_object'` option on `ExtractOptions`, gated to `LOCAL_PROVIDERS` only so custom `OPENAI_BASE_URL` endpoints (OpenRouter, etc.) that route to models without JSON mode support do not start 400ing. Both failure modes (no JSON in response, JSON.parse error) now log a 200 char preview of the raw LLM content under `[parse-query] FAIL ...`, mirroring the existing pattern in `extract-prices.ts`, so future Ollama misconfig is diagnosable from container logs.

### Documentation
* **Picking a local model** subsection in the LLM Providers README block: short size based guidance for current generation families (Qwen3, Qwen3.5, Gemma 3n, Gemma 4) plus an explicit "avoid" line for models under 1B (TinyLlama, etc.) and older generations (Llama 3.x, Qwen 2.5). Driven by issue #84 reporter feedback after they spent time on TinyLlama and llama3.1:8b without guidance.

## [0.7.2] - 2026-05-21

### Added
- **Manual force scrape per tracker** (#78): refresh icon next to the pause / delete actions on the landing card, `/account` row, `/admin/queries` row, and the `/q/[id]` footer. New `POST /api/queries/[id]/scrape` cascades across siblings sharing the row's `groupId` (same shape as pause and delete), pre creates a `FetchRun` row with `status=in_progress, source=manual` so the status dot lights up the moment you click, then runs the actual scrapes serially in the background so they do not race the shared ExpressVPN sidecar. Per group throttle is 60 seconds; longer running scrapes also block repeat clicks via a non stale `in_progress` lock that auto expires after 15 minutes to recover from crashed processes. A 20 sibling flex group is roughly 10 minutes of background work, so each click can produce a non trivial LLM bill on a busy account.
- **Visual scrape status indicator** (#78): coloured dot next to the "last checked" timestamp on every dashboard surface (`SavedTrackers`, `/account`, `/admin/queries`, `/q/[id]` footer). Green success, red failed (tooltip surfaces the underlying error: "LLM response contained no parseable JSON array", "Page did not load results", etc.), yellow partial, pulsing blue while in flight. Aggregates across siblings with `in_progress > failed > partial > success` precedence so an active refresh always pulses and a single failing sibling cannot hide behind successful ones.
- **Custom Model ID input for Google provider** (#81): `allowCustomModel` is now on the google registry entry alongside openai, ollama, llamacpp, and vllm. Settings, setup, and `/admin/config` render the "Or type a custom model ID" text input for Google. Users hitting the `gemini-2.5-flash` 20 RPD free tier cap on flex trackers running a 3h cron can now type `gemini-3.1-flash-lite` (500 RPD free) or any other Gemini model id without waiting for the curated dropdown to catch up. Custom ids fall through `getModelCosts()` and report 0 input / 0 output, same as the OpenAI custom path.

### Fixed
- **Stacked chart header date bubble showed a one day range for flex groups** (#78): `/q/[id]` read `primary.query.dateFrom` and `primary.query.dateTo` from the primary sibling, but for a flex group every sibling is a single pinned day, so the header bubble rendered as "Nov 7 to Nov 7" instead of the actual group span. Extracted the date range into a `lib/query-grouping.ts` helper that walks every sibling, with a regression test that uses the exact Nov 7 to Nov 11 case from the reporter's screenshot. The same helper drives the OpenGraph share card title which had the same bug.
- **Manual force scrape endpoint review findings** (PR #82 second and third passes): stale lock cutoff bumped from 5 to 15 minutes so a long flex group does not get killed mid run; VPN pass lock gap closed so a sidecar pass acquired but never released cannot wedge the group; startup failure inside the background IIFE marks the pre created `FetchRun` row as failed instead of leaving it stuck in `in_progress`; documented the cross group cron tradeoff in the endpoint comment so it does not get re introduced.

## [0.7.1] - 2026-05-20

### Added
- **Unified tracking link and per chart dates for flex queries** (#78): flex (`flex=N`) and multi route searches used to fan out into 10 or 20 sibling rows in every dashboard, and the stacked chart page omitted the date on every block past the page header. The dashboard surfaces (`SavedTrackers`, `/account`, `/admin/queries`) now collapse siblings by the `groupId` the create handler was already stamping, rendering one card per query with a `N charts` chip when the group has more than one date and a `+ N more` tail when it spans multiple destinations. Every chart block on `/q/[id]` now reads its own outbound date (plus return date for round trips) next to the route header. New sort dropdown on the stacked view orders by ascending date (default) or lowest current price first, skipping sold out flights so a stale snapshot can't rank a route as cheapest. View, pause, and delete from any dashboard operate on the whole group. New `lib/query-grouping.ts` helper plus 11 unit tests; new cascade and `groupDelete` coverage on both `/api/queries/[id]` and `/api/admin/queries/[id]`.

### Fixed
- **`/api/queries/[id]` PATCH only updated `scrapeInterval`** (#78): the handler ignored an `active` body field, so a future "pause group" UX would have silently broken. PATCH now accepts an `active` boolean and cascades it to every sibling sharing the row's `groupId`, the same way `scrapeInterval` already did. Blank body 400s rather than no-op'ing. Admin PATCH on `/api/admin/queries/[id]` gained the matching cascade (active, scrapeInterval, maxDurationHours); `userId` reassignment stays single row.
- **`SavedTrackers` pause hit the admin route** (#78): the landing page pause button used to fetch `/api/admin/queries/[id]`, which 401s for anonymous and non admin users. Now it hits the user PATCH route with the primary's `deleteToken` (or the user/admin session) and uses the new cascade so every sibling flips together.
- **Stacked chart page reported group expired when only the earliest sibling had passed** (#78): `expired` was derived from the primary sibling alone, but `primaryId` is the earliest sibling by `dateFrom`, so on a per date flex group the earliest can be in the past while later siblings are still active. Page level `expired` now uses `allQueries.every(q => now > q.expiresAt)` and the countdown surfaces the latest `expiresAt`.

## [0.7.0] - 2026-05-14

### Added
- **Multi user mode for self hosted households** (#44): optional accounts feature that lets a self hosted Fairtrail serve a household. Hard gated on `SELF_HOSTED=true` so fairtrail.org is never multi user. Toggle on via the setup wizard's new Step 3 ("Run Fairtrail for a household?") or the admin Settings page. Enabling atomically creates the first admin User, flips `ExtractionConfig.multiUserMode=true`, and backfills existing unowned non seed trackers to the new admin (one time dismissible banner on `/admin/users` shows the count). New schema: `User` with per user preference overrides (currency, country, airlines, cabin), `Query.userId` nullable with `onDelete SetNull`. New API: `/api/auth/{login,logout,me}`, `/api/account/settings`, `/api/admin/{multi-user,users,users/[id]}`; `PATCH /api/admin/queries/[id]` accepts `userId` for admin reassignment. New pages: unified `/login` for admins and non admins, `/account` (per user tracker list), `/account/settings`, `/admin/users`. Session tokens grow a `user:<id>:<ts>.<sig>` variant alongside admin tokens, sharing one HMAC primitive and the `ft-session` cookie. `getCurrentUser()` does a per request DB lookup so deleted users lose access immediately. Login rate limited (5 failures per 15 min per IP plus username). Headless CLI attaches new trackers to the first admin in multi user mode. `lib/admin-guard.ts` protects every legacy `/api/admin/*` handler so non admin household members cannot bypass the dashboard UI via direct curl. Edge middleware tightened to require `admin:` payload prefix. Legacy `/api/admin/auth` returns 410 in multi user mode. 13 reference screenshots in `assets/accounts/` captured from the production Docker build.

### Fixed
- **Cron silently failed for queries whose picked flights were on a "known" airline** (#65 follow-up): when a user picked a flight in the preview picker (e.g. Turkish Airlines for BRI to JFK), `apps/web/src/app/api/queries/route.ts` and `packages/cli/src/lib/create-queries.ts` auto-derived `preferredAirlines` from the picked flights. The cron scraper then treated `preferredAirlines` as a navigation strategy (`useAirlineDirect = directAirlines.length > 0`) and routed every cycle to `https://www.turkishairlines.com/.../?origin=BRI&destination=JFK`. Turkish's site does not accept raw IATA codes, auto-resolves BRI to Lecce, and renders a 1964 char marketing stub. The stub satisfied `navigateAirlineDirect`'s loose `/€|EUR|USD/` regex so the existing Google Flights fallback never fired. Three-layer fix: (1) `queries/route.ts` and `create-queries.ts` no longer auto-derive `preferredAirlines` from `selectedFlights`; (2) new `hasFlightPriceSignal` helper in `navigate.ts` requires both currency density (3+ mentions) and a letter-bounded price token, rejecting stubs while accepting `EUR99` / `EUR 1,200` / `€431` / `EUR 1.299`; (3) `scrapeOneDatePair` now diversifies to Google Flights when `airline_direct` extracts zero prices with `empty_extraction`/`no_json_in_response`/`page_not_loaded`/`llm_error`, but never on `all_filtered_out` (real flights, filters worked). Once diversification fires, attempt-2 retry skips the broken airline launch. Composite source label (`airline_direct+google_flights`) on `FetchRun.source` for operators to grep. Existing rows with stale `preferredAirlines` recover via (3); no DB migration needed. 13 new behavioral tests across `route.test.ts`, `create-queries.test.ts` (new), `navigate.test.ts`, `run-scrape.test.ts`.
- **Multi user pages 404'd on production Docker builds** (accounts follow up): `/login`, `/admin/login`, the admin dashboard layout, and the landing page read `isMultiUserEnabled()` and `getCurrentUser()` but did not opt out of Next.js static prerendering. At build time the DB is not reachable, so `isMultiUserEnabled()` returned false, `notFound()` ran, and the 404 was baked into the static bundle. Added `export const dynamic = 'force-dynamic'` to each of the four entry points so the multi user gate runs per request.
- **Codex audit findings on the accounts feature** (PR #77): every legacy `/api/admin/*` handler (config, queries, seed-routes, insights, providers, local-models, analytics) is now gated by `requireAdminApi()` so a non admin household member cannot reset the admin password via direct curl; Edge middleware requires `admin:` payload prefix; multi user toggle race fixed with a guarded `updateMany WHERE multiUserMode=false` inside the transaction; `/api/auth/logout` returns 404 in solo/hosted modes for consistency with the other `/api/auth/*` endpoints; rate limiter's trust assumption on `x-forwarded-for` documented.

## [0.6.0] - 2026-05-12

### Added
- **Bounded parallelism in preview runner** (#65 follow up): the serial scrape loop in `runPreview` was a 20 pair query bottleneck (about 10 minutes worst case). New worker pool runs up to `PREVIEW_CONCURRENCY` scrapes in flight, default 3, env configurable. Workers share a single `nextIndex++` counter and write into preallocated `routes[i]` slots so input task order is preserved in the API response regardless of which worker settles first. JS single threading makes the counter atomic. For the reporter's 20 pair BRI/BDS to JFK/EWR query latency drops to roughly 3 to 4 minutes on a healthy provider.
- **Per IP admission cap for active previews** (audit follow up): new `PreviewRun.clientIp` column plus `(clientIp, status, updatedAt)` index. POST `/api/preview` extracts the IP from `x-forwarded-for`, counts fresh active runs for that IP, and returns 429 once the cap is reached. Default cap 3, env `PREVIEW_ADMISSION_CAP` overrides (clamped 1 to 50). The freshness filter on `updatedAt` means a zombie row where the heartbeat died will not falsely block a new submission.
- **Sliding window per provider RPM limiter** (audit follow up): with parallelism plus the `llm_error` retry path, a single 20 route preview could burst above Gemini free tier 15 RPM and trip its own retry loop. New `lib/scraper/rate-limit.ts` smooths bursts by blocking just long enough to keep the rolling 60 second window under the configured limit. Defaults: `GOOGLE_RPM=15`, `ANTHROPIC_RPM=50`, `OPENAI_RPM=60`, `GROQ_RPM=30`, all env overridable. Local providers (ollama, llamacpp, vllm) and CLI providers (claude code, codex, gemini CLI) skip the limiter.
- **Env configurable preview concurrency** (audit follow up): `PREVIEW_CONCURRENCY` env var with default 3, clamped to `[1, 10]`. Operators on a small VPS where each chromium launch costs roughly 150 MB can opt out of the parallel default without a code change.
- **Independent timer based heartbeat for long previews** (audit follow up): a 60 second `setInterval` runs alongside the per task `onTaskComplete` callback in `runPreviewInBackground`. If any individual heartbeat write fails transiently, the next interval tick still bumps `updatedAt` within 60 seconds, well under the 30 minute stale window. Cleared on both completed and failed exits before the terminal write.

### Fixed
- **20 pair flex queries silently dropped completed results** (#65 follow up): the SearchBar poll loop checked the 5 minute frontend cutoff before checking `status === 'completed'`. A result landing at 5:00:01 was discarded and `previewRunId` was cleared from `sessionStorage`, leaving the completed `PreviewRun` row sitting in the database for 24 hours unreachable from the UI. Poll order now resolves completed and failed branches before the cutoff check. Frontend cutoff bumped to 30 minutes, backend `PREVIEW_ACTIVE_TIMEOUT_MS` matched.
- **GET stale marker race overwrote completed runs** (#65 follow up): the GET `/api/preview/[id]` handler read the row with `findUnique`, then ran an unconditional `update` by id alone to flip the row failed if it looked stale. Between the read and the update, `runPreviewInBackground` could write `completed` and the GET would overwrite the terminal state with a stale failed marker. New path uses `updateMany` with `status: { in: ACTIVE_PREVIEW_STATUSES }` and `updatedAt: { lt: staleBefore }` in the where clause, then refetches. If the row already moved out of the active set, the update affects zero rows.
- **Backend stale marker had no heartbeat during scrapes** (#65 follow up): `runPreviewInBackground` only wrote `updatedAt` at three transitions (pending to running, completed, failed). Any healthy scrape exceeding the active window got falsely marked failed by the next GET poll. New per task `onTaskComplete` callback bumps `updatedAt` after every task settles. Combined with the 60 second timer above, `updatedAt` advances frequently enough that the stale marker only fires on truly stuck runs.
- **Poll catch branch had no cutoff** (audit A1): a sustained network or JSON failure for 30 plus minutes would keep retrying every 3 seconds without ever surfacing the timeout error. Both poll branches (success and catch) now go through a shared `checkCutoff` helper.
- **extractPrices read the DB on every attempt despite the hoist** (audit A4): the hoist in `runPreview` only covered `scrapeRoute`'s direct call; `extractPrices` still hit `prisma.extractionConfig.findFirst` on every retry. New `ExtractionConfigOverride` parameter lets callers pass the already resolved provider, model, and customBaseUrl. A 20 route preview now reads the config once at the top of `runPreview` instead of dozens of times.
- **Debug HTML filenames could collide under parallelism** (audit A4): two parallel workers scraping the same route on different dates in the same millisecond could overwrite each other's debug HTML. The path now includes `taskIndex` and `dateFromStr` so collisions are impossible within a single preview run.
- **POST blocked on cleanup before responding** (audit B4): `cleanupExpiredPreviewRuns` and `markStalePreviewRunsFailed` used to await before the 202 response. Both are now fire and forget; failures log but never affect the POST result. Admission counting filters by `updatedAt` freshness so deferred sweep cannot leak stale rows into the cap arithmetic.

## [0.5.5] - 2026-05-10

### Fixed
- **`fairtrail --headless` failed on podman-compose** (#72 follow-up): every TUI flag (`--headless`, `--list`, `--view`, `--backend`, `--model`) aborted with `podman-compose: error: unrecognized arguments: -it`. `cmd_tui` hardcoded `-it`/`-i` between `exec` and the service name, but `podman-compose exec` accepts only `-d`, `--privileged`, `-u`, `-T`, `--index`, `-e`, `-w` (verified against `podman_compose.py:4636-4683`); the other three compose flavors fairtrail-cli supports (docker compose v2, docker-compose v1, podman compose v5+ native) implement Docker's surface and accept `-it`/`-i` unchanged. Fix: new `apps/web/public/fairtrail-cli-flags.sh` exporting `_compose_exec_flags(dc, stdin_tty, stdout_tty)` that whitelists the four flavors and emits the right flags by flavor — empty/`-T` for `podman-compose`, `-it`/`-i` for the rest. Hard-fails on unknown flavors so future `nerdctl compose` / `finch compose` cannot silently inherit docker flags. Source guard at the top of `fairtrail-cli` aborts with a clear message if the helper is missing post-install. `install.sh` and `cmd_update` ship/refresh the helper alongside the CLI.
- **VPN sidecar enabled by commented-out `EXPRESSVPN_CODE`**: `cmd_*` runtime detection used `grep -q "EXPRESSVPN_CODE" .env` which matched commented placeholder lines like `# EXPRESSVPN_CODE=` and unset entries like `EXPRESSVPN_CODE=`. A user with the default-generated `.env` example would silently start the ExpressVPN sidecar with no activation code. Now requires `^[[:space:]]*EXPRESSVPN_CODE=.+` — non-commented, non-empty value.

### Changed
- **Pre-Release Gate now requires `scripts/cli-runtime-test.sh`** alongside the existing `docker-smoke-test.sh` and `install-flow-test.sh`. The new behavioral harness runs the actual CLI under shimmed `docker`/`podman`/`*compose`/`curl`/`open` binaries across 4 runtime configurations (docker compose v2, docker-compose v1, podman compose native, podman-compose) and asserts every recorded invocation. The `podman-compose` shim mirrors the real argparser and rejects `-i`/`-it`/`-t`/`--interactive`/`--tty` with exit 2, so any future regression that hardcodes `-it` for podman fails the suite at runtime — the previous source-grep tests would have shipped #72 again. 89 assertions cover `cmd_tui`, `cmd_update` (issue #72 v1 force-recreate), `cmd_start_*`, `cmd_logs`, `cmd_stop`/`cmd_uninstall` cancel-and-confirm paths, `cmd_search` (3 POST endpoints + python3 dependency + browser-launch stubbed via `open`/`xdg-open`), `cmd_status`, `cmd_version`, override compose file composition, and the missing-helper failure path. `install-flow-test.sh` adds 6 static guards (helper API matrix, helper used by `cmd_tui`, no raw `-it`/`-i` in `$_DC exec`, install ships and update refreshes the helper, helper rejects unknown compose flavor). 110 total assertions; CI gates the `ci` job on both suites.

## [0.5.4] - 2026-05-09

### Fixed
- **`fairtrail update` did not actually update the running container** (#72): `cmd_update` called `dc up -d` after `dc pull web`. On podman-compose, plain `up -d` does not always detect that `ghcr.io/affromero/fairtrail:latest` now points to a different digest and skips the recreate, so users kept running the old image even though the pull succeeded. Now ensures db/redis are up via `dc up -d --no-recreate db redis`, then force-recreates web with `dc up -d --force-recreate --no-deps --remove-orphans web` (the same pattern the production deploy script already uses). Regression test added to `scripts/install-flow-test.sh` asserting the `cmd_update` block carries `--force-recreate` and `--no-deps` for the web service.

## [0.5.3] - 2026-05-09

### Fixed
- **Airline URL builders ignored `tripType`** (#65 follow-up): all 24 airline builders unconditionally injected `returnDate=dateTo` even for one-way trips, where `dateTo === dateFrom`. Carrier sites (Turkish Airlines, Delta, etc.) rendered an invalid-date interstitial and the LLM extracted zero flights. Refactored `airline-urls.ts` from raw template strings to a declarative `AirlineSpec` map + `URLSearchParams` builder mirroring PR #68's pattern in `navigate.ts`. One-way drops the return-date key entirely; three carriers (southwest, delta, american) flip explicit one-way tokens. Avianca and United keep their non-standard URL shapes via `customBuilder`. `assertValidIataCode` and `isoDate` are now exported from `navigate.ts` so the IATA injection guard applies at the airline-builder boundary too. 24-airline behavioral test matrix added.
- **Flexible date ranges only scraped `dateFrom`** (#65 follow-up): for "around Nov 9 +/- 2 days" stored as `dateFrom=Nov 7, dateTo=Nov 11`, the cron path called navigate once with a single `searchParams`. The Google Flights URL builder for one-way only emits `on dateFrom`, so Nov 8-11 were silently skipped. New `scrape-dates.ts` with `expandQueryDates` helper iterates every day in `[dateFrom, dateTo]` for one-way queries (capped at 7 evenly-spaced pairs). `scrapeQueryForCountry` now loops per pair into a single shared `FetchRun`. Sold-out detection scoped to dates actually scraped this run AND gated on `prices.length > 0`, so prior snapshots are not mass-flagged when the pair set changes between runs OR when a pair scrape itself failed. Each pair's call has its own try/catch so one browser crash does not discard prior pair results. Round-trip flex iteration is deferred to a future migration (`returnTravelDate` column on `PriceSnapshot` plus `flightId` awareness).
- **Silent extraction failures** (#65 follow-up): cron logs showed `[extract] sending ...` then nothing until the next summary line, because (a) `@google/generative-ai` 0.24 has no default request timeout, (b) the provider `extract()` and `JSON.parse` were both un-wrapped, and (c) the outer catch in `runScrapeForQuery` wrote to `FetchRun.error` but never `console.error`. New `EXTRACT_TIMEOUT_MS` (default 90s, env-overridable). Anthropic, OpenAI, Ollama, llamacpp, and vllm pass `signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS)` to the SDK client. Gemini uses its native `SingleRequestOptions { signal, timeout }` on `generateContent`. Two new `ExtractionFailureReason`s (`llm_error`, `json_parse_error`) returned from `extractPrices` with `console.error` at every boundary. Outer catch in `runScrapeForQuery` logs before the DB write. Both new reasons added to `RETRYABLE_FAILURES` so transient provider blips get one retry, and to `failureMessages` for the admin dashboard. Pre-merge codex audit caught 3 blockers (sold-out scoping, RT pair collision, per-pair throw isolation) addressed in commit 4 of PR #71.

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
