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

# Include only Prisma's generated-client runtime and PostgreSQL adapter closure.
# Missing required packages must fail the build rather than produce a partial image.
RUN set -e; cd /app; mkdir -p /ext/@prisma; \
    for p in client adapter-pg driver-adapter-utils client-runtime-utils debug; do \
      cp -R "node_modules/@prisma/$p" "/ext/@prisma/$p"; \
    done

# Prisma CLI as a self-contained toolchain for the entrypoint schema push.
# The CLI is a devDependency, so it is absent from the lean runtime
# node_modules, and fetching it with npx at container start round-trips the
# registry and fails in restricted networks. Install its locked dependency tree
# in isolation, then copy the whole tree into the runner. Its exact version is
# checked against the project's CLI and client. The entrypoint invokes
# this CLI with explicit --schema/--url flags (no prisma.config.ts at runtime),
# and v7's client is Rust-free (WASM query compiler), so there is no engine
# binary to match the alpine target.
FROM docker.io/library/node:26-alpine AS prismacli
RUN apk add --no-cache openssl
WORKDIR /pcli
COPY scripts/prisma-cli/package.json scripts/prisma-cli/package-lock.json ./
RUN npm ci --loglevel=error

FROM docker.io/library/node:26-alpine AS builder
RUN apk add --no-cache libc6-compat openssl python3 make g++
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Keep workspace-local dependency versions alongside the hoisted shared tools.
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY . .
RUN node scripts/check-prisma-toolchain.mjs
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

FROM proddeps AS cliruntime
COPY scripts/stage-cli-runtime.mjs /stage-cli-runtime.mjs
COPY --from=builder /app/packages/cli/dist/metafile-esm.json /cli-metafile.json
RUN node /stage-cli-runtime.mjs /app /cli-runtime /cli-metafile.json

# Merge overlapping runtime dependencies before they enter the final image.
# Separate COPY layers retain overwritten package files in the image archive.
FROM scratch AS runtimeassets
COPY --from=builder --chown=1000:1000 /app/apps/web/.next/standalone /app
COPY --from=proddeps --chown=1000:1000 /ext /app/node_modules
COPY --from=builder --chown=1000:1000 /app/packages/cli/dist /app/packages/cli/dist
COPY --from=builder --chown=1000:1000 /app/packages/cli/package.json /app/packages/cli/package.json
COPY --from=cliruntime --chown=1000:1000 /cli-runtime /app

FROM docker.io/library/node:26-alpine AS runner
RUN apk add --no-cache libc6-compat openssl chromium curl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG COMMIT_SHA=unknown
LABEL org.opencontainers.image.revision=${COMMIT_SHA}
ENV PORT=3003
ENV HOSTNAME="0.0.0.0"
ENV CHROME_PATH=/usr/bin/chromium-browser
ENV BROWSER_SINGLE_PROCESS=true

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
COPY --chown=node:node scripts/update-cli.mjs /app/update-cli.mjs
COPY --chown=node:node scripts/cli-retention.mjs /app/cli-retention.mjs
COPY --chown=node:node cli-versions.json /app/cli-versions.json

# Standalone server and CLI with their merged runtime dependencies.
COPY --from=runtimeassets /app /app
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Prisma schema (the entrypoint db push reads it). The generated client and its
# @prisma/client runtime (WASM query compiler) and PostgreSQL adapter are staged
# as complete runtime packages above. The separate Prisma CLI retains its own
# toolchain. v7 has no node_modules/.prisma engine dir.
COPY --from=builder --chown=node:node /app/apps/web/prisma ./apps/web/prisma

# Self-contained Prisma CLI for the entrypoint schema push (db push). Calling
# it directly avoids the unreliable runtime `npx prisma` registry fetch.
COPY --from=prismacli --chown=node:node /pcli/node_modules /app/prisma-cli/node_modules

RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/index.js "$@"\n' > /home/node/.npm-global/bin/flight-finder-tui \
    && chmod +x /home/node/.npm-global/bin/flight-finder-tui \
    && chown node:node /home/node/.npm-global/bin/flight-finder-tui

RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node docker-entrypoint.sh ./
COPY --chown=node:node seed-cli-credentials.mjs ./
COPY --chown=node:node scripts/apply-travel-constraints.mjs ./scripts/apply-travel-constraints.mjs
RUN chmod +x docker-entrypoint.sh seed-cli-credentials.mjs
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
