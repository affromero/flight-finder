import { defineConfig } from 'prisma/config';

// Prisma 7 moved the datasource connection string out of schema.prisma (the
// `url = env(...)` line is gone) and into this config. The CLI (generate, db
// push, migrate) reads the URL from here; the runtime PrismaClient connects via
// the @prisma/adapter-pg driver adapter wired up in lib/prisma.ts instead.
//
// Secrets come from Infisical (no .env files), so DATABASE_URL is already on
// process.env when the CLI needs to connect (infisical run --projectId 48fd7083-5c5c-425b-8900-24e6b2626ea5 --env dev -- ... locally, the
// entrypoint's generated env in Docker).
export default defineConfig({
  schema: 'apps/web/prisma/schema.prisma',
  migrations: {
    path: 'apps/web/prisma/migrations',
  },
  datasource: {
    // process.env (not the strict env() helper) so config-loading contexts that
    // don't connect -- prisma generate in CI and the Docker builder -- don't
    // throw on a missing DATABASE_URL. db push/migrate get the real value at
    // runtime (infisical locally; --url in the container entrypoint).
    url: process.env.DATABASE_URL,
  },
});
