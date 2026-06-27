# AGENTS.md

Guidance for AI coding agents working on **Flight Finder**, a self-hosted flight
price tracker. This is the cross-tool entry point. See [CLAUDE.md](CLAUDE.md) for
the deeper conventions and the "Altitude" design system, [README.md](README.md)
for the product overview, and [API.md](API.md) for the runtime HTTP API you can
call against a running instance.

## Stack

TypeScript (strict) monorepo on **Node >= 22**, npm workspaces. Next.js 16 (App
Router, React 19) web app, Prisma 7 over PostgreSQL 16, Redis 7 for caching and
rate limiting, Playwright for scraping, Vitest for tests. Secrets come from
**Doppler**, never `.env` files.

## Setup

```bash
npm install
docker compose up -d db redis      # or: make setup
npm run db:push                    # apply the Prisma schema
npm run db:generate                # generate the Prisma client
npm run dev                        # Next.js web app on http://localhost:3003
```

`make dev` wraps the database, Redis, and dev-server steps.

## Checks (run before every commit and PR)

```bash
npm run ci         # lint + typecheck + test + build (web) + build (cli)
# or individually:
npm run lint       # ESLint, both workspaces, --max-warnings 0
npm run typecheck  # tsc strict, both workspaces
npm run test       # Vitest, both workspaces
```

`npm run ci` must pass before you push; GitHub Actions runs the same gate. Linting
is zero-warnings and typecheck is strict (`noUncheckedIndexedAccess`).

## Monorepo layout

- `apps/web`: the Next.js app and API backend (`@flight-finder/web`). Prisma schema
  at `apps/web/prisma/schema.prisma`; core logic under `apps/web/src/lib/` (auth,
  prisma, redis, notifications, scraper).
- `packages/cli`: the Ink/React terminal UI (`@flight-finder/cli`). It reuses the
  scraper from `apps/web` via relative imports.
- `apps/desktop`: the Tauri (Rust) launcher. It is **not** an npm workspace and is
  built and versioned on its own.

All four version points (root, `apps/web`, `packages/cli`, `apps/desktop`) are kept
in lockstep; the `/create-release` flow bumps them together.

## Conventions

- **TypeScript strict, no `any`.** Use early returns, at most 3 nesting levels, and
  keep files under 1000 lines.
- **Styling is CSS Modules only** (`Component.tsx` + `Component.module.css`). No
  Tailwind, no inline styles. Server Components by default; add `'use client'` only
  when needed.
- **API routes** validate input, return proper HTTP status codes, and respond via
  the `apiSuccess()` / `apiError()` helpers.
- **Tests** target behavior, not implementation details (Vitest).
- **Commits** use Conventional Commit subjects: `feat:`, `fix:`, `docs:`,
  `refactor:`, `chore:`, `test:`.

## Secrets

Never use `.env` files and never commit secrets. Everything flows through Doppler
(`doppler run -- <command>`). Provider API keys (Anthropic, OpenAI, Gemini, local)
resolve through `resolveApiKey()` in `apps/web/src/lib/scraper/ai-registry.ts`,
where DB-stored encrypted keys take precedence over env vars. Do not read
`process.env.<PROVIDER>_API_KEY` directly; go through the registry.

## CLI shim gotcha

`packages/cli` maps `@/*` to `packages/cli/src/` and reuses the scraper from
`apps/web` via relative imports. Any new `@/lib/<x>` import added to a shared
scraper file needs a matching shim in `packages/cli/src/lib/` (re-export the real
module or provide a stub). Web-only tests pass without it; the full `npm run ci`
(web + cli) is what catches a missing shim.

## Releasing

Releases are tag driven and version-locked across all four packages. Run the
pre-release gate first (the `docker-smoke`, `install-flow`, `cli-runtime`, and
`migration` scripts under `scripts/`, listed in CLAUDE.md), then use the
`/create-release` flow, which bumps every version point and regenerates the
lockfiles. Web tags are `vX.Y.Z`; desktop tags are `desktop-vX.Y.Z`.
