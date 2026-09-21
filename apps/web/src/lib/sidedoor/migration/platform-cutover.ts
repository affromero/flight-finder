import { randomUUID } from 'node:crypto';
import {
  AccessService,
  accessStateSchema,
  hashConfiguredPassword,
  importPasswordHash,
  initialAccessState,
  initializeAccess,
  tokenHash,
  type Principal,
} from 'thesidedoor-core/access';
import { credentialStateSchema } from 'thesidedoor-core/configuration';
import { providerDescriptors } from 'thesidedoor-core/ai/catalog';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/secret-crypto';
import { providerVault } from '../providers/provider-credentials';
import { sharedStateStore } from '../access/store';

const ACCESS_IMPORT = 'flight-finder-platform-v1';
const PROVIDER_IMPORT = 'flight-finder-platform-v1';
const CUTOVER_STATE = 'flight-finder-platform-cutover';

type Database = Prisma.TransactionClient;
type SourceUser = {
  id: string;
  username: string;
  passwordHash: string | null;
  isAdmin: boolean;
  createdAt: Date;
};
type SourceConfig = {
  provider: string;
  customBaseUrl: string | null;
  multiUserMode: boolean;
  setupComplete: boolean | null;
  adminPasswordHash: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  googleApiKey: string | null;
};
type CutoverRecord = {
  version: 1;
  setupComplete: boolean;
  sourceUsers: number;
  sourceProviders: string[];
};

async function columns(database: Database, table: string): Promise<Set<string>> {
  const rows = await database.$queryRawUnsafe<Array<{ column_name: string }>>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
    table,
  );
  return new Set(rows.map(row => row.column_name));
}

async function ensureStateTable(database: Database): Promise<void> {
  await database.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "SidedoorState" ("id" TEXT PRIMARY KEY, "revision" TEXT NOT NULL, "state" JSONB NOT NULL)',
  );
}

async function sourceUsers(database: Database, userColumns: Set<string>): Promise<SourceUser[]> {
  if (!userColumns.has('id')) return [];
  const password = userColumns.has('passwordHash') ? '"passwordHash"' : 'NULL::TEXT';
  return database.$queryRawUnsafe<SourceUser[]>(
    `SELECT "id", "username", ${password} AS "passwordHash", "isAdmin", "createdAt" FROM "User" ORDER BY "createdAt", "id"`,
  );
}

async function sourceConfig(database: Database, configColumns: Set<string>): Promise<SourceConfig | null> {
  if (!configColumns.has('id')) return null;
  const value = (name: string, fallback: string) => configColumns.has(name) ? `"${name}"` : fallback;
  const rows = await database.$queryRawUnsafe<SourceConfig[]>(
    `SELECT ${value('provider', "'anthropic'::TEXT")} AS "provider",
      ${value('customBaseUrl', 'NULL::TEXT')} AS "customBaseUrl",
      ${value('multiUserMode', 'FALSE')} AS "multiUserMode",
      ${value('setupComplete', 'NULL::BOOLEAN')} AS "setupComplete",
      ${value('adminPasswordHash', 'NULL::TEXT')} AS "adminPasswordHash",
      ${value('anthropicApiKey', 'NULL::TEXT')} AS "anthropicApiKey",
      ${value('openaiApiKey', 'NULL::TEXT')} AS "openaiApiKey",
      ${value('googleApiKey', 'NULL::TEXT')} AS "googleApiKey"
    FROM "ExtractionConfig" WHERE "id" = 'singleton' LIMIT 1`,
  );
  return rows[0] ?? null;
}

function availableName(users: readonly SourceUser[], principals: readonly Principal[]): string {
  const names = new Set([...users.map(user => user.username), ...principals.map(principal => principal.name)].map(name => name.toLowerCase()));
  for (const candidate of ['admin', 'instance-admin']) if (!names.has(candidate)) return candidate;
  let suffix = 2;
  while (names.has(`instance-admin-${suffix}`)) suffix++;
  return `instance-admin-${suffix}`;
}

function importedPassword(value: string | null): string | null {
  if (!value || value === 'self-hosted') return null;
  return importPasswordHash(value);
}

async function initialPrincipals(
  users: readonly SourceUser[],
  config: SourceConfig | null,
): Promise<Principal[]> {
  const principals = users.map(user => ({
    id: user.id,
    name: user.username,
    role: user.isAdmin ? 'owner' as const : 'member' as const,
    passwordHash: importedPassword(user.passwordHash),
    epoch: 0,
    createdAt: user.createdAt.getTime(),
  }));
  const configuredHash = importedPassword(config?.adminPasswordHash ?? null);
  const configuredPassword = config && !configuredHash && config.adminPasswordHash !== 'self-hosted'
    ? process.env.SIDEDOOR_IMPORT_ADMIN_PASSWORD || null
    : null;
  const passwordHash = configuredHash ?? (configuredPassword ? await hashConfiguredPassword(configuredPassword) : null);
  if (!passwordHash) return principals;
  principals.push({
    id: randomUUID(),
    name: availableName(users, principals),
    role: 'owner',
    passwordHash,
    epoch: 0,
    createdAt: Date.now(),
  });
  return principals;
}

function credentialValues(config: SourceConfig | null): Array<{ provider: string; values: Record<string, string> }> {
  const encrypted = {
    anthropic: config?.anthropicApiKey,
    openai: config?.openaiApiKey,
    google: config?.googleApiKey,
  };
  const environment = {
    anthropic: process.env.SIDEDOOR_IMPORT_ANTHROPIC_API_KEY,
    openai: process.env.SIDEDOOR_IMPORT_OPENAI_API_KEY,
    google: process.env.SIDEDOOR_IMPORT_GOOGLE_API_KEY,
  };
  const imported = new Map<string, Record<string, string>>();
  for (const [provider, value] of Object.entries(encrypted)) {
    const values = imported.get(provider) ?? {};
    const environmentValue = environment[provider as keyof typeof environment];
    if (value) {
      const plaintext = decryptSecret(value);
      if (!plaintext) throw new Error(`Stored ${provider} credentials could not be decrypted`);
      values.apiKey = plaintext;
      if (provider === config?.provider && config.customBaseUrl) values.compatibleApiKey = plaintext;
    } else if (environmentValue) {
      values.apiKey = environmentValue;
    }
    if (Object.keys(values).length) imported.set(provider, values);
  }
  const descriptor = providerDescriptors().find(provider => provider.id === config?.provider);
  if (config?.customBaseUrl && descriptor?.fields.some(field => field.id === 'baseUrl')) {
    const selected = imported.get(config.provider) ?? {};
    selected.baseUrl = config.customBaseUrl;
    imported.set(config.provider, selected);
  }
  return [...imported].map(([provider, values]) => ({ provider, values }));
}

async function prepareInTransaction(database: Database): Promise<CutoverRecord> {
  await ensureStateTable(database);
  const pending = await database.$queryRawUnsafe<Array<{ state: CutoverRecord }>>(
    'SELECT "state" FROM "SidedoorState" WHERE "id" = $1',
    CUTOVER_STATE,
  );
  if (pending[0]) {
    const record = pending[0].state;
    if (record.version !== 1 || typeof record.setupComplete !== 'boolean' ||
        !Number.isSafeInteger(record.sourceUsers) || record.sourceUsers < 0 ||
        !Array.isArray(record.sourceProviders) || record.sourceProviders.some(provider => typeof provider !== 'string'))
      throw new Error('Platform cutover record is invalid');
    const access = accessStateSchema.parse((await database.$queryRawUnsafe<Array<{ state: unknown }>>(
      'SELECT "state" FROM "SidedoorState" WHERE "id" = $1',
      'access',
    ))[0]?.state);
    const credentials = credentialStateSchema.parse((await database.$queryRawUnsafe<Array<{ state: unknown }>>(
      'SELECT "state" FROM "SidedoorState" WHERE "id" = $1',
      'provider-credentials',
    ))[0]?.state);
    if (!access.initializations.includes(ACCESS_IMPORT) || !credentials.imports.includes(PROVIDER_IMPORT) ||
        record.sourceProviders.some(provider => !credentials.providers.some(item => item.provider === provider)))
      throw new Error('Platform state verification failed');
    return record;
  }
  const [userColumns, configColumns] = await Promise.all([
    columns(database, 'User'),
    columns(database, 'ExtractionConfig'),
  ]);
  const [users, config] = await Promise.all([
    sourceUsers(database, userColumns),
    sourceConfig(database, configColumns),
  ]);
  const accessStore = sharedStateStore('access', accessStateSchema.parse, initialAccessState, database);
  const existingAccess = await database.$queryRawUnsafe<Array<{ state: unknown }>>(
    'SELECT "state" FROM "SidedoorState" WHERE "id" = $1',
    'access',
  );
  if (!existingAccess.length) {
    if (users.length && !userColumns.has('passwordHash'))
      throw new Error('Access state is missing for existing application accounts');
    const principals = await initialPrincipals(users, config);
    const added = principals.filter(principal => !users.some(user => user.id === principal.id));
    if (added.length) {
      if (!userColumns.has('id')) throw new Error('Application accounts are unavailable for configured administrators');
      for (const principal of added) {
        await database.$executeRawUnsafe(
          `INSERT INTO "User" ("id", "username", "isAdmin", "createdAt", "updatedAt") VALUES ($1, $2, TRUE, $3, $3)`,
          principal.id,
          principal.name,
          new Date(principal.createdAt),
        );
      }
    }
    const gatePassword = process.env.SIDEDOOR_IMPORT_PASSWORD;
    await initializeAccess(accessStore, ACCESS_IMPORT, {
      mode: 'household',
      householdPasswordHash: gatePassword ? await hashConfiguredPassword(gatePassword) : null,
      principals,
    });
    const machineToken = process.env.SIDEDOOR_IMPORT_MACHINE_TOKEN;
    if (machineToken) {
      await accessStore.transact(state => {
        state.deviceTokens.push({
          id: tokenHash(machineToken),
          principalId: null,
          issuerSessionId: `initialize:${ACCESS_IMPORT}`,
          epoch: state.householdEpoch,
          scopes: ['api'],
          name: 'Flight Finder automation',
          createdAt: Date.now(),
          expiresAt: null,
        });
      });
    }
  } else {
    const state = accessStateSchema.parse(existingAccess[0]!.state);
    if (!state.initializations.includes(ACCESS_IMPORT)) {
      if (userColumns.has('passwordHash')) throw new Error('Access state conflicts with the installed account records');
      if (users.length) throw new Error('Access state is missing for existing application accounts');
      throw new Error('Access state was initialized by another source');
    }
  }

  const { store, vault } = providerVault(database);
  await store.transact(state => {
    if (state.imports.includes(PROVIDER_IMPORT)) return;
    if (state.providers.length) throw new Error('Provider credentials were initialized by another source');
    for (const item of credentialValues(config)) vault.configureState(state, item.provider, item.values);
    state.imports.push(PROVIDER_IMPORT);
  });

  const access = await accessStore.read();
  const credentials = credentialStateSchema.parse(await store.read());
  if (!access.initializations.includes(ACCESS_IMPORT) || !credentials.imports.includes(PROVIDER_IMPORT))
    throw new Error('Platform state verification failed');
  const record: CutoverRecord = {
    version: 1,
    setupComplete: config?.setupComplete ?? Boolean(config?.adminPasswordHash || config?.multiUserMode || users.length),
    sourceUsers: users.length,
    sourceProviders: credentials.providers.map(provider => provider.provider).sort(),
  };
  await database.$executeRawUnsafe(
    `INSERT INTO "SidedoorState" ("id", "revision", "state") VALUES ($1, $2, $3::jsonb)
      ON CONFLICT ("id") DO UPDATE SET "revision" = EXCLUDED."revision", "state" = EXCLUDED."state"`,
    CUTOVER_STATE,
    randomUUID(),
    JSON.stringify(record),
  );
  return record;
}

export async function preparePlatformCutover(): Promise<CutoverRecord & { recoveries: Array<{ principalId: string; code: string }> }> {
  const record = await prisma.$transaction(prepareInTransaction, { isolationLevel: 'Serializable' });
  const state = accessStateSchema.parse((await prisma.sidedoorState.findUniqueOrThrow({ where: { id: 'access' } })).state);
  const service = new AccessService({ store: sharedStateStore('access', accessStateSchema.parse, () => state) });
  const recoveries: Array<{ principalId: string; code: string }> = [];
  if (process.env.SIDEDOOR_PREPARE_ONLY === 'true') {
    for (const principal of state.principals.filter(principal => principal.role === 'owner' && principal.passwordHash === null)) {
      recoveries.push({ principalId: principal.id, code: await service.issueOperatorToken(principal.id) });
    }
  }
  return { ...record, recoveries };
}

export async function finalizePlatformCutover(): Promise<CutoverRecord> {
  return prisma.$transaction(async database => {
    const row = await database.sidedoorState.findUnique({ where: { id: CUTOVER_STATE } });
    if (!row) {
      const access = await database.sidedoorState.findUniqueOrThrow({ where: { id: 'access' } });
      const credentials = await database.sidedoorState.findUniqueOrThrow({ where: { id: 'provider-credentials' } });
      if (!accessStateSchema.parse(access.state).initializations.includes(ACCESS_IMPORT) ||
          !credentialStateSchema.parse(credentials.state).imports.includes(PROVIDER_IMPORT))
        throw new Error('Platform state verification failed');
      const config = await database.extractionConfig.findUnique({ where: { id: 'singleton' } });
      return { version: 1, setupComplete: Boolean(config?.setupComplete), sourceUsers: 0, sourceProviders: [] };
    }
    const record = row.state as CutoverRecord;
    const access = accessStateSchema.parse((await database.sidedoorState.findUniqueOrThrow({ where: { id: 'access' } })).state);
    const credentials = credentialStateSchema.parse((await database.sidedoorState.findUniqueOrThrow({ where: { id: 'provider-credentials' } })).state);
    if (!access.initializations.includes(ACCESS_IMPORT) || !credentials.imports.includes(PROVIDER_IMPORT) ||
        record.sourceProviders.some(provider => !credentials.providers.some(item => item.provider === provider)))
      throw new Error('Platform state verification failed');
    await database.extractionConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', setupComplete: record.setupComplete },
      update: { setupComplete: record.setupComplete },
    });
    await database.sidedoorState.delete({ where: { id: CUTOVER_STATE } });
    return record;
  }, { isolationLevel: 'Serializable' });
}
