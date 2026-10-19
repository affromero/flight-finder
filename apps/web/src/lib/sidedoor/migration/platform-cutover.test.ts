import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrypt } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const databaseUrl = process.env.SIDEDOOR_TEST_DATABASE_URL;
const repository = resolve('../..');
let admin: pg.Client;
let databaseName = '';
let connection = '';
let temporary = '';
const SOURCE_SCHEMA = `
datasource db {
  provider = "postgresql"
}
model ExtractionConfig {
  id String @id @default("singleton")
  provider String @default("anthropic")
  model String @default("claude-haiku-4-5-20251001")
  customBaseUrl String?
  adminPasswordHash String?
  anthropicApiKey String?
  openaiApiKey String?
  googleApiKey String?
  multiUserMode Boolean @default(false)
  updatedAt DateTime @updatedAt
}
model User {
  id String @id @default(cuid())
  username String @unique
  passwordHash String?
  isAdmin Boolean @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;

async function passwordHash(password: string, cost: number): Promise<string> {
  const salt = '0123456789abcdef0123456789abcdef';
  const key = await new Promise<Buffer>((resolveKey, reject) => {
    scrypt(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, value) => {
      if (error) reject(error);
      else resolveKey(value);
    });
  });
  return `${salt}:${key.toString('hex')}`;
}

async function push(schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try {
    const hasTables = Number((await client.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].count) > 0;
    const args = [
      resolve('../../node_modules/prisma/build/index.js'),
      'migrate',
      'diff',
      ...(hasTables ? ['--from-config-datasource'] : ['--from-empty']),
      '--to-schema',
      schema,
      '--script',
    ];
    const { stdout } = await run(process.execPath, args, { cwd: repository });
    if (!stdout.includes('CREATE TABLE') && !hasTables) throw new Error(`Prisma produced no initial schema SQL: ${stdout}`);
    await client.query(stdout);
    if (!hasTables) {
      const created = Number((await client.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].count);
      if (!created) throw new Error('Prisma schema SQL created no tables');
    }
  } finally {
    await client.end();
  }
}

describe.skipIf(!databaseUrl)('installed platform cutover with PostgreSQL', () => {
  beforeAll(async () => {
    const source = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(source.hostname) || source.pathname !== '/sidedoor_test')
      throw new Error('Platform cutover tests require the dedicated local sidedoor_test database');
    admin = new pg.Client({ connectionString: source.href });
    await admin.connect();
    databaseName = `sidedoor_cutover_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    source.pathname = `/${databaseName}`;
    connection = source.href;
    process.env.DATABASE_URL = connection;
    process.env.SELF_HOSTED = 'true';
    temporary = await mkdtemp(join(tmpdir(), 'flight-finder-platform-cutover-'));
  });

  beforeEach(async () => {
    process.env.SIDEDOOR_IMPORT_ADMIN_PASSWORD = 'environment admin password';
    process.env.SIDEDOOR_IMPORT_PASSWORD = 'private instance password';
    process.env.SIDEDOOR_IMPORT_MACHINE_TOKEN = 'machine-token-that-stays-valid';
    process.env.SIDEDOOR_IMPORT_ANTHROPIC_API_KEY = 'environment-anthropic-key';
    process.env.SIDEDOOR_IMPORT_OPENAI_API_KEY = 'environment-openai-key';
    process.env.SIDEDOOR_IMPORT_GOOGLE_API_KEY = 'environment-google-key';

    const reset = new pg.Client({ connectionString: connection });
    await reset.connect();
    try {
      await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    } finally {
      await reset.end();
    }
    const baseline = join(temporary, 'baseline.prisma');
    await writeFile(baseline, SOURCE_SCHEMA);
    await push(baseline);

    const { encryptSecret } = await import('@/lib/secret-crypto');
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "User" ("id", "username", "passwordHash", "isAdmin", "createdAt", "updatedAt")
          VALUES ('owner-id', 'Owner', $1, TRUE, now(), now()), ('guest-id', 'Guest', NULL, FALSE, now(), now())`,
        [await passwordHash('owner imported password', 16384)],
      );
      await client.query(
        `INSERT INTO "ExtractionConfig" ("id", "provider", "model", "adminPasswordHash", "anthropicApiKey", "customBaseUrl", "multiUserMode", "updatedAt")
          VALUES ('singleton', 'anthropic', 'claude-haiku-4-5-20251001', $1, $2, 'https://models.example.test/v1', TRUE, now())`,
        [await passwordHash('database admin password', 32768), encryptSecret('stored-provider-key')],
      );
    } finally {
      await client.end();
    }
  }, 60_000);

  afterAll(async () => {
    const { prisma } = await import('@/lib/prisma');
    await prisma.$disconnect();
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
    delete process.env.SIDEDOOR_IMPORT_ANTHROPIC_API_KEY;
    delete process.env.SIDEDOOR_IMPORT_OPENAI_API_KEY;
    delete process.env.SIDEDOOR_IMPORT_GOOGLE_API_KEY;
    delete process.env.SELF_HOSTED;
  });

  it.each(['stored', 'environment'] as const)('preserves a solo administrator from a required-password schema using the %s password', async source => {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await client.query('DELETE FROM "User"; ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL');
      if (source === 'environment') await client.query('UPDATE "ExtractionConfig" SET "adminPasswordHash" = NULL');
      delete process.env.SIDEDOOR_IMPORT_PASSWORD;
      const password = source === 'stored' ? 'database admin password' : 'environment admin password';
      const { preparePlatformCutover, finalizePlatformCutover } = await import('./platform-cutover');
      await expect(preparePlatformCutover()).resolves.toMatchObject({ setupComplete: true, sourceUsers: 0 });
      const users = (await client.query('SELECT id, username, "passwordHash" FROM "User"')).rows;
      expect(users).toHaveLength(1);
      const { verifyPassword } = await import('thesidedoor-core/access');
      expect(await verifyPassword(password, users[0].passwordHash)).toBe(true);
      await expect(preparePlatformCutover()).resolves.toMatchObject({ sourceUsers: 0 });
      expect((await client.query('SELECT id FROM "User"')).rows).toEqual([{ id: users[0].id }]);
      expect((await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'passwordHash'`)).rows[0].is_nullable).toBe('NO');

      await push(resolve('prisma/schema.prisma'));
      await finalizePlatformCutover();
      const { sharedAccess, sharedAccessStore } = await import('../access/service');
      const { HouseholdProfileService } = await import('thesidedoor-core/access');
      const session = await sharedAccess.enterHousehold(password);
      await new HouseholdProfileService(sharedAccess).select(session, users[0].id);
      expect((await sharedAccess.authenticate(session, true)).principal?.role).toBe('owner');
      const before = (await sharedAccessStore.read()).principals;
      await preparePlatformCutover();
      await finalizePlatformCutover();
      expect((await sharedAccessStore.read()).principals).toEqual(before);
      const { resolveProviderCredentials } = await import('../providers/provider-credentials');
      expect((await resolveProviderCredentials('anthropic')).apiKey).toBe('stored-provider-key');
    } finally {
      await client.end();
    }
  }, 60_000);

  it('rolls back a newly imported solo administrator when saved provider credentials cannot be decrypted', async () => {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await client.query('DELETE FROM "User"; ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL');
      await client.query(`UPDATE "ExtractionConfig" SET "anthropicApiKey" = 'unreadable-credential'`);
      const { preparePlatformCutover } = await import('./platform-cutover');
      await expect(preparePlatformCutover()).rejects.toThrow('could not be decrypted');
      expect((await client.query('SELECT id FROM "User"')).rows).toEqual([]);
      expect((await client.query(`SELECT to_regclass('public."SidedoorState"') AS name`)).rows[0].name).toBeNull();
      const { encryptSecret } = await import('@/lib/secret-crypto');
      await client.query('UPDATE "ExtractionConfig" SET "anthropicApiKey" = $1', [encryptSecret('recovered-provider-key')]);
      await expect(preparePlatformCutover()).resolves.toMatchObject({ setupComplete: true });
      expect((await client.query('SELECT id FROM "User"')).rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  }, 60_000);

  it('preserves access, provider, machine and setup behavior before removing source columns', async () => {
    const { preparePlatformCutover, finalizePlatformCutover } = await import('./platform-cutover');
    const prepared = await preparePlatformCutover();
    expect(prepared).toMatchObject({ setupComplete: true, sourceUsers: 2, sourceProviders: ['anthropic', 'google', 'openai'] });

    const { sharedAccess, sharedAccessStore } = await import('../access/service');
    await expect(sharedAccess.login('Owner', 'owner imported password')).rejects.toMatchObject({ code: 'unauthorized' });
    const state = await sharedAccessStore.read();
    expect(state.principals.filter(principal => principal.role === 'owner')).toHaveLength(1);
    const admitted = await sharedAccess.enterHousehold('private instance password');
    expect((await sharedAccess.authenticate(admitted)).principal).toBeNull();
    await new (await import('thesidedoor-core/access')).HouseholdProfileService(sharedAccess).select(admitted, 'owner-id');
    expect((await sharedAccess.authenticate(admitted, true)).principal?.id).toBe('owner-id');

    const { DeviceService } = await import('thesidedoor-core/access');
    const devices = new DeviceService({ access: sharedAccess, scopesFor: () => ['api'] });
    expect((await devices.authenticate('machine-token-that-stays-valid', ['api'])).scopes).toEqual(['api']);
    const { resolveProviderCredentials } = await import('../providers/provider-credentials');
    expect(await resolveProviderCredentials('anthropic')).toEqual({
      apiKey: 'stored-provider-key',
      baseUrl: 'https://models.example.test/v1',
      compatibleApiKey: 'stored-provider-key',
    });
    expect(await resolveProviderCredentials('openai')).toEqual({ apiKey: 'environment-openai-key' });
    expect(await resolveProviderCredentials('google')).toEqual({ apiKey: 'environment-google-key' });

    const before = new pg.Client({ connectionString: connection });
    await before.connect();
    expect((await before.query(`SELECT "passwordHash" FROM "User" WHERE id = 'owner-id'`)).rows[0].passwordHash).toBeTruthy();
    await before.end();

    await push(resolve('prisma/schema.prisma'));
    await expect(preparePlatformCutover()).resolves.toMatchObject({ setupComplete: true, sourceUsers: 2, sourceProviders: ['anthropic', 'google', 'openai'] });
    const finalized = await finalizePlatformCutover();
    expect(finalized).toMatchObject({ setupComplete: true, sourceUsers: 2, sourceProviders: ['anthropic', 'google', 'openai'] });

    const { prisma } = await import('@/lib/prisma');
    const migratedUsers = await prisma.user.findMany({ select: { id: true, username: true } });
    expect(migratedUsers).toHaveLength(2);
    expect(migratedUsers).toEqual(expect.arrayContaining([
      { id: 'guest-id', username: 'Guest' },
      { id: 'owner-id', username: 'Owner' },
    ]));
    expect((await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).setupComplete).toBe(true);
    expect(await prisma.sidedoorState.findUnique({ where: { id: 'flight-finder-platform-cutover' } })).toBeNull();

    await expect(preparePlatformCutover()).resolves.toMatchObject({ setupComplete: true, sourceUsers: 2 });
    await expect(finalizePlatformCutover()).resolves.toMatchObject({ setupComplete: true, sourceUsers: 2 });
  }, 60_000);
});
