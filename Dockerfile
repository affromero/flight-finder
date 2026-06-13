FROM docker.io/library/node:26-alpine AS deps
RUN apk add --no-cache libc6-compat openssl python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY apps/web/prisma ./apps/web/prisma/
RUN npm ci --loglevel=error

# Production-only deps (no devDependencies)
FROM docker.io/library/node:26-alpine AS proddeps
RUN apk add --no-cache libc6-compat openssl python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY apps/web/prisma ./apps/web/prisma/
RUN npm ci --omit=dev --loglevel=error

# Stage the externalized packages (serverExternalPackages) and the transitive
# deps the Next standalone trace omits. Resolve each from wherever npm hoisted
# it (the root or the apps/web workspace) and skip any a dependency bump dropped.
# A hardcoded COPY list is brittle: ioredis dropped lodash.*, and Next 16's tree
# hoists @anthropic-ai into the workspace rather than the root.
#
# playwright/playwright-core MUST be here: the standalone trace follows their JS
# requires but misses browsers.json, which playwright-core reads dynamically at
# chromium.launch(). Without the full package the scraper dies with
# "Cannot find module '.../playwright-core/browsers.json'" (issue #139 follow-up).
RUN set -e; cd /app; mkdir -p /ext; \
    for p in ioredis @ioredis redis-parser redis-errors denque standard-as-callback \
             cluster-key-slot debug ms ua-parser-js @anthropic-ai json-schema-to-ts \
             @babel/runtime ts-algebra openai @google \
             playwright playwright-core; do \
      for base in node_modules apps/web/node_modules; do \
        if [ -e "$base/$p" ]; then mkdir -p "/ext/$(dirname "$p")"; cp -R "$base/$p" "/ext/$p"; break; fi; \
      done; \
    done

# Prisma CLI as a self-contained toolchain for the entrypoint schema push.
# The CLI is a devDependency, so it is absent from the lean runtime
# node_modules, and fetching it with npx at container start round-trips the
# registry and fails in restricted networks. Install it in isolation here so
# the full dependency closure is bundled, then copy the whole tree into the
# runner. Pinned to the v7 major that matches the schema. The entrypoint invokes
# this CLI with explicit --schema/--url flags (no prisma.config.ts at runtime),
# and v7's client is Rust-free (WASM query compiler), so there is no engine
# binary to match the alpine target.
FROM docker.io/library/node:26-alpine AS prismacli
RUN apk add --no-cache openssl
WORKDIR /pcli
RUN npm install --no-save --no-package-lock prisma@7

FROM docker.io/library/node:26-alpine AS builder
RUN apk add --no-cache libc6-compat openssl python3 make g++
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# npm hoists most deps to root, but tsup lands in packages/cli/node_modules
# (workspace local). Without this, the CLI build fails with `tsup: not found`.
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY . .
# Prisma 7 generates its client into apps/web/src/generated (gitignored), so
# regenerate it from the copied source before the builds compile it into the
# Next standalone output and the CLI bundle. prisma.config.ts is present here and
# `prisma` is installed (devDeps), so the config loads; no DATABASE_URL needed.
RUN npx prisma generate --schema=apps/web/prisma/schema.prisma
ARG COMMIT_SHA=unknown
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV NEXT_PUBLIC_COMMIT_SHA=${COMMIT_SHA}
RUN npm run build --workspace=@flight-finder/web
RUN npm run build --workspace=@flight-finder/cli

FROM docker.io/library/node:26-alpine AS runner
RUN apk add --no-cache libc6-compat openssl chromium curl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3003
ENV HOSTNAME="0.0.0.0"
ENV CHROME_PATH=/usr/bin/chromium-browser

# CLI provider support: writable npm global prefix for node user
# *-host dirs are read-only mount points; entrypoint copies into writable dirs
RUN mkdir -p /home/node/.npm-global/bin \
             /home/node/.claude /home/node/.claude-host \
             /home/node/.codex /home/node/.codex-host && \
    chown -R node:node /home/node/.npm-global \
                       /home/node/.claude /home/node/.claude-host \
                       /home/node/.codex /home/node/.codex-host
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH="/home/node/.npm-global/bin:$PATH"

WORKDIR /app

# Standalone server (includes traced node_modules)
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/public ./apps/web/public

# Prisma schema (the entrypoint db push reads it). The generated client and its
# @prisma/client runtime (WASM query compiler) come in via the Next standalone
# trace; @prisma is copied too so the runtime adapter (@prisma/adapter-pg) and
# client are guaranteed present. v7 has no node_modules/.prisma engine dir.
COPY --from=builder --chown=node:node /app/apps/web/prisma ./apps/web/prisma
COPY --from=proddeps --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# Self-contained Prisma CLI for the entrypoint schema push (db push). Calling
# it directly avoids the unreliable runtime `npx prisma` registry fetch.
COPY --from=prismacli --chown=node:node /pcli/node_modules /app/prisma-cli/node_modules

# Overlay the externalized packages staged in /ext by the proddeps stage,
# resolved from wherever npm hoisted them. Versions match the standalone trace
# because both come from the same lockfile.
COPY --from=proddeps --chown=node:node /ext ./node_modules

# Ink terminal UI (flight-finder-tui). The CLI's runtime deps (ink, react,
# chalk, commander, ink-*, plus their transitives) are not in the lean
# Next standalone trace, so we ship the full proddeps node_modules under
# /app/packages/cli/node_modules. Two layers:
#   1. Root proddeps node_modules — supplies ink, react, etc. (hoisted).
#   2. Workspace local proddeps node_modules — overrides commander v13 and
#      chalk v5 that npm could not hoist due to version conflicts at root.
# Without layer 2 the wrapper picks up commander v2.20.3 which is ESM hostile.
COPY --from=builder --chown=node:node /app/packages/cli/dist /app/packages/cli/dist
# Ship the cli package.json next to dist so Node finds "type":"module" when it
# resolves dist/index.js. Without it Node walks up to the Next standalone
# /app/package.json (no type field) and reparses every run as ESM, printing the
# MODULE_TYPELESS_PACKAGE_JSON performance warning.
COPY --from=builder --chown=node:node /app/packages/cli/package.json /app/packages/cli/package.json
COPY --from=proddeps --chown=node:node /app/node_modules /app/packages/cli/node_modules
COPY --from=proddeps --chown=node:node /app/packages/cli/node_modules /app/packages/cli/node_modules
RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/index.js "$@"\n' > /home/node/.npm-global/bin/flight-finder-tui \
    && chmod +x /home/node/.npm-global/bin/flight-finder-tui \
    && chown node:node /home/node/.npm-global/bin/flight-finder-tui

RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER node
RUN flight-finder-tui --help >/dev/null
# Guard: the recovery commands depend on tsup's `@`->apps/web/src alias inlining
# the real admin-recovery into the bundle. If the typecheck/dev stub leaks in
# instead, every recovery run would throw. Fail the build if its sentinel is
# present.
RUN if grep -q 'admin-recovery stub' /app/packages/cli/dist/index.js; then \
      echo 'ERROR: admin-recovery stub leaked into the CLI bundle' >&2; exit 1; \
    fi
EXPOSE 3003
# INFRA-9: probe the /api/health endpoint so Docker (and compose) can report
# container health and restart unhealthy containers automatically.
# curl is available via the chromium apk layer.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -sf http://localhost:3003/api/health || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
