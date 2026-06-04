# CLAUDE.md — Flight Finder

> **Flight Finder** — The price trail airlines don't show you. Flight price evolution tracker with natural language search and shareable charts.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15+ (App Router), TypeScript, CSS Modules |
| Database | PostgreSQL 16 + Prisma ORM |
| Cache | Redis 7 (rate limiting + response caching) |
| AI | Anthropic Claude, OpenAI GPT, Google Gemini, Claude Code CLI, Ollama, llama.cpp, vLLM |
| Browser | Playwright (headless Chromium for Google Flights scraping) |
| Charts | Plotly.js (interactive price evolution) |
| Hosting | Hetzner VPS (Docker Compose + Caddy) — flight-finder.org |
| CI/CD | GitHub Actions (CI + Deploy on push to main) |

## Monorepo

npm workspaces: `@flight-finder/web` (`apps/web/`).
Root `package.json` proxies to `@flight-finder/web`.

**Versioning:** the release version of record is `apps/web/package.json` (git tags `vX.Y.Z` track it). The root `package.json` version is not published, but release tooling reads it, so bump it to match `apps/web` on every release (`/create-release` must update both, plus the lockfile). `packages/cli` is versioned independently.

## Environment Variables

All secrets via **Doppler** — NEVER use `.env` files. Project: `flight-finder`, config: `dev`.
Scripts wrap with `doppler run --`. Shared LLM keys from `pricetoken` Doppler project.

Critical: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `CRON_SECRET`.

## Build Commands

```bash
npm install                    # All workspaces
docker compose -f docker-compose.prod.yml up -d db redis
npx prisma db push --schema=apps/web/prisma/schema.prisma
npx prisma generate --schema=apps/web/prisma/schema.prisma
npm run dev                    # Web app on :3003 (wraps with doppler run)
npm run ci                     # lint + typecheck + build
```

## File Index

### `apps/web/src/app/` — Pages & API routes

| Path | Purpose |
|------|---------|
| `page.tsx` | Landing page — natural language search bar |
| `layout.tsx` | Root layout — fonts, metadata |
| `q/[id]/page.tsx` | Public shareable chart page (no auth) |
| `admin/(auth)/login/page.tsx` | Admin login (legacy, redirects to /login in multi user mode) |
| `admin/(dashboard)/page.tsx` | Admin dashboard — active queries, costs |
| `admin/(dashboard)/queries/page.tsx` | Query management — pause/resume/delete/reassign |
| `admin/(dashboard)/config/page.tsx` | LLM agent config — provider/model selection |
| `admin/(dashboard)/notifications/page.tsx` | Notification channels + new-low alert thresholds |
| `admin/(dashboard)/users/page.tsx` | User management (multi user mode only) — create/reset/delete |
| `login/page.tsx` | Unified login (multi user mode only) — admin + non admin |
| `account/page.tsx` | Logged in user's tracker list (multi user mode only) |
| `account/settings/page.tsx` | Per user preferences — currency, country, airlines, cabin |
| `api/parse/route.ts` | POST — LLM parses natural language flight query |
| `api/queries/route.ts` | POST — create new tracked query (401 anon in multi user mode) |
| `api/queries/[id]/prices/route.ts` | GET — public price data for chart |
| `api/cron/scrape/route.ts` | GET — trigger scrape run (CRON_SECRET auth) |
| `api/auth/login/route.ts` | POST — user login (multi user mode only); rate limited |
| `api/auth/logout/route.ts` | POST — clears the shared ft-session cookie |
| `api/auth/me/route.ts` | GET — current user; 401/404 outside multi user mode |
| `api/admin/auth/route.ts` | POST — legacy admin login; 410 in multi user mode |
| `api/admin/auth/logout/route.ts` | POST — admin logout |
| `api/admin/queries/route.ts` | GET — list all queries |
| `api/admin/queries/[id]/route.ts` | PATCH/DELETE — manage query; PATCH accepts userId reassignment |
| `api/admin/config/route.ts` | GET/PATCH — extraction config (exposes isSelfHosted) |
| `api/admin/multi-user/route.ts` | POST — enable multi user mode atomically (creates first admin, backfills); DELETE — disable (admin only, clears admin hash) |
| `api/admin/users/route.ts` | GET/POST — list/create users (admin only) |
| `api/admin/users/[id]/route.ts` | PATCH/DELETE — reset password, toggle isAdmin, delete |
| `api/admin/notifications/route.ts` | GET/POST — list/create global notification channels (admin) |
| `api/admin/notifications/[id]/route.ts` | PATCH/DELETE — update/toggle/delete a channel |
| `api/admin/notifications/[id]/test/route.ts` | POST — send a test notification (rate limited) |
| `api/account/settings/route.ts` | GET/PATCH — current user's preferences |
| `api/account/password/route.ts` | POST — self-service password change (verifies current, rate limited) |
| `api/health/route.ts` | GET — health check (DB + Redis) |

### `apps/web/src/components/` — UI components

| Component | Purpose |
|-----------|---------|
| `SearchBar` | Natural language flight query input with syntax highlighting |
| `ConfirmationCard` | Parsed query display with "Track this flight" button |
| `PriceChart` | Plotly.js wrapper — price evolution, airline colors, click→book |
| `BestPrice` | Highlight card for cheapest price found |
| `PriceHistory` | Table with trend arrows and booking links |

### `apps/web/src/lib/` — Core logic

| File | Purpose |
|------|---------|
| `prisma.ts` | Prisma client singleton |
| `redis.ts` | Redis client + cache helpers |
| `api-response.ts` | `apiSuccess()`/`apiError()` response helpers |
| `admin-auth.ts` | HMAC session tokens (admin), password verification, shared signPayload/verifyPayload |
| `user-auth.ts` | User session tokens, parseSession discriminated union, getCurrentUser (DB-backed) |
| `multi-user.ts` | `isMultiUserEnabled()` (hard gated on SELF_HOSTED, cached 60s) |
| `rate-limit.ts` | Redis backed login throttling (5 per 15 min per IP+username) |
| `password.ts` | scrypt hashing and verification |
| `secret-crypto.ts` | AES-256-GCM encrypt/decrypt for secrets at rest (keyed on ADMIN_SESSION_SECRET) |
| `notifications/` | New-low alert detection + dispatch + pluggable channel senders (Telegram, email, ntfy, webhook) |

### `apps/web/src/lib/scraper/` — Extraction pipeline

| File | Purpose |
|------|---------|
| `ai-registry.ts` | Provider registry (Anthropic, OpenAI, Google, Claude Code) |
| `parse-query.ts` | LLM parses natural language into structured flight query |
| `navigate.ts` | Playwright navigates Google Flights, captures HTML |
| `extract-prices.ts` | LLM extracts structured price data from page |
| `run-scrape.ts` | Orchestrates full scrape run across active queries |

## Prisma Schema

Models: `Query` (tracked flights, optional `userId` owner), `PriceSnapshot` (price data points), `FetchRun` (scrape run logs), `ExtractionConfig` (LLM settings singleton; `multiUserMode` flag), `ApiUsageLog` (cost tracking), `User` (multi user accounts, self hosted only).

## Design System: "Altitude"

Supports light/dark themes via `data-theme` attribute on `<html>`.

**Dark (default):** bg `#031820`, surface `#072530`, elevated `#0e3640`, border `#1a4a52`, accent `#80a8a5` (mid teal), text `#ecdfc0` (warm cream), secondary `#d4a574` (muted gold).
**Light (basic-light):** bg `#faf6ed` (cream), surface `#f1ead9`, elevated `#e8dfc8`, border `#d6cbae`, accent `#1a4a52` (deep teal), text `#031820`.
**Price up alert (shared):** `#c1272d` scarlet. Reserved for emphasis on rising prices, alerts, and editorial callouts.

Fonts: Bricolage Grotesque (display), Outfit (body), IBM Plex Mono (data).

Vintage travel poster aesthetic. Deep teal and cream with a scarlet alert accent. Pan Am and French Line ocean liner heritage. No amber primary, kept out to steer clear of the AI tool palette.

Other themes (cyberpunk, tron, autumn, solar-red) remain as user-selectable alternates in `theme.ts`.

## Scraping Constraints

- **Rate limit:** Google returns HTTP 429 after ~30 sustained requests from the same IP. The default 3h cron interval stays well under this.
- **RT pricing:** Google Flights shows the full round-trip price on each flight result. The extraction prompt accounts for this -- do not sum outbound + return prices.
- **Google internal API:** undocumented endpoints exist (`GetShoppingResults`, `GetCalendarGraph`, `GetExploreDestinations`) but lack booking URLs, currency control, fare classes, and seat counts. We use Playwright for data completeness. See README comparison.

## Engineering Patterns

- **Component**: `Name.tsx` + `Name.module.css`. Named export, `styles.root`.
- **API Route**: Validate → query → `NextResponse.json()` with `apiSuccess()`/`apiError()`.
- **Scraper**: Playwright navigate → capture HTML → LLM extract → store snapshots.
- **Admin auth**: HMAC session cookie, verified in `middleware.ts` for pages, in handler for cron.
- **Accounts (self hosted multi user mode)**: opt-in DB flag (`ExtractionConfig.multiUserMode`) gated by `SELF_HOSTED=true`. Admin enables via Settings or setup wizard; the toggle handler atomically creates the first admin User, flips the flag, and backfills existing unowned non-seed queries. User auth is per-route via `getCurrentUser()` (DB lookup so deleted users lose access immediately). Token shape: `admin:<ts>.<sig>` for legacy admin, `user:<userId>:<ts>.<sig>` for users; both share the `ft-session` cookie. Login rate limited via `lib/rate-limit.ts`.

## DO

- Use CSS Modules for all styling
- Use TypeScript strict mode
- Use Server Components by default
- Return proper HTTP status codes
- Cache API responses in Redis (5min TTL)
- Use `doppler run --` for all scripts that need secrets

## Pre-Release Gate (MANDATORY before `/create-release`)

All four tests must pass before tagging a release:

```bash
./scripts/docker-smoke-test.sh    # Docker infra: build, health, chromium, extraction, DB
./scripts/install-flow-test.sh    # Static + grep regression checks on install.sh / flight-finder-cli
./scripts/cli-runtime-test.sh     # Behavioral CLI runtime matrix (docker v1/v2, podman compose, podman-compose)
./scripts/migration-test.sh       # Static checks on ~/.flight-finder to ~/.flight-finder migration + deprecated alias
```

If any fails, fix the issue and re-run. Do NOT tag without all four passing.

The release commit must bump both `apps/web/package.json` and the root `package.json` to the new version (and regenerate `package-lock.json`) so the root version stays accurate for tooling that reads it.

The runtime-matrix harness (`cli-runtime-test.sh`) is what catches the
"works on docker, broken on podman" class of bug (issues #62, #72). It
shims `docker`/`podman`/`*compose`/`curl` and asserts the recorded
invocations — every CLI command across every compose flavor.

## DON'T

- Use Tailwind, inline styles, or styled-components
- Use `any` type
- Use `.env` files — always Doppler
- Commit API keys or secrets
