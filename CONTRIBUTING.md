# Contributing to Flight Finder

Thanks for your interest in contributing! Flight Finder is a self-hosted flight price tracker and we welcome contributions of all kinds.

## Development Setup

Requires Node.js >= 22.

```bash
git clone git@github.com:affromero/flight-finder.git
cd flight-finder
npm install
docker compose up -d db redis
npm run db:push
npm run db:generate
npm run dev
```

Set your environment variables (copy `.env.example` to `.env` and add at least one LLM API key).

## Before Submitting a PR

```bash
npm run ci   # lint + typecheck + build
```

All three must pass. The linter runs with `--max-warnings 0` (zero tolerance).

## Code Style

- **TypeScript** — strict mode, no `any` types
- **CSS Modules** — `Component.tsx` + `Component.module.css`, no Tailwind or inline styles
- **Server Components** by default, `'use client'` only when needed
- **API routes** — validate input, return proper HTTP status codes, use `apiSuccess()`/`apiError()` helpers

## Architecture Guidelines

- Keep files under 1000 lines — extract into focused modules
- Use early returns, max 3 nesting levels
- Test behavior, not implementation details
- No `.env` files in commits — secrets via environment variables

## What to Contribute

- **New LLM providers** — add to `apps/web/src/lib/scraper/ai-registry.ts`
- **Extraction improvements** — better price parsing, new airline support
- **UI enhancements** — chart features, responsive design, accessibility
- **Documentation** — setup guides, troubleshooting, translations
- **Bug fixes** — check [Issues](https://github.com/affromero/flight-finder/issues)

## Commit Messages

Use conventional format:
- `feat: add airline price alerts`
- `fix: handle missing departure time in extraction`
- `docs: add Docker ARM64 instructions`

## Questions?

Open an issue or start a discussion. We're happy to help!
