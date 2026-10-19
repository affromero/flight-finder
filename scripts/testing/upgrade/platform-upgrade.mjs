import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { scryptSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { tsImport } from 'tsx/esm/api';
import { accessStateSchema, verifyPassword } from 'thesidedoor-core/access';
import { CredentialCodec, credentialStateSchema } from 'thesidedoor-core/configuration';
import { providerDescriptors } from 'thesidedoor-core/ai/catalog';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const image = process.argv[2];
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'Pass the immutable local image ID');
assert.ok(process.env.GITHUB_ACTIONS === 'true' || process.env.FLIGHT_FINDER_DISPOSABLE_DOCKER === '1', 'A disposable local Docker daemon is required');
const execute = promisify(execFile);
async function command(executable, args, options = {}) {
  try {
    const result = await execute(executable, args, { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${executable} ${args.join(' ')} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
  }
}
assert.ok((await command('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).startsWith('unix://'), 'Remote Docker contexts are not allowed');
assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix://'), 'Remote Docker endpoints are not allowed');
const directory = await mkdtemp(join(tmpdir(), 'flight-finder-platform-upgrade-'));
const prefix = `ff-upgrade-${randomUUID().slice(0, 8)}`;
const databaseContainer = `${prefix}-db`;
const redisContainer = `${prefix}-redis`;
const web = `${prefix}-web`;
const password = 'historical-admin-test-password';
const gatePassword = 'historical-household-test-password';
const providerKey = 'historical-openai-test-key';
const sessionSecret = 'historical-upgrade-stable-session-secret';
process.env.ADMIN_SESSION_SECRET = sessionSecret;
const { encryptSecret, deriveSecretEncryptionKey } = await tsImport('../../../apps/web/src/lib/secret-crypto.ts', import.meta.url);
const codec = new CredentialCodec({ namespace: 'flight-finder:provider-credentials', descriptors: providerDescriptors, encryptionKey: deriveSecretEncryptionKey });
const cases = [
  { name: 'required-password-solo', ref: 'v0.10.0', cost: 16384 },
  { name: 'required-password-environment', ref: 'v0.10.0', cost: 32768, environment: true },
  { name: 'nullable-password-solo', ref: 'v0.15.0', cost: 32768 },
  { name: 'nullable-password-profiles', ref: 'v0.15.0', cost: 16384, profiles: true, gate: true },
  { name: 'current-local-setup', ref: 'v0.16.0', current: true },
];
let admin;
let client;
let databaseCreated = false;
let redisCreated = false;
let networkCreated = false;
let webCreated = false;

function legacyHash(cost) {
  const salt = '0123456789abcdef0123456789abcdef';
  return `${salt}:${scryptSync(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex')}`;
}
async function waitForDatabase(connection) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const candidate = new pg.Client({ connectionString: connection });
    try {
      await candidate.connect();
      return candidate;
    } catch {
      await candidate.end();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error('Disposable database did not become ready');
}
async function waitForHealth(base) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) {
      const health = await response.json();
      if (health.status === 'ok' && health.database === 'connected' && health.redis === 'connected') return;
    }
    if (await command('docker', ['inspect', '--format', '{{.State.Running}}', web]) !== 'true') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const logs = await execute('docker', ['logs', web]);
  const state = await command('docker', ['inspect', '--format', '{{json .State}}', web]);
  throw new Error(`Upgrade failed to become healthy (${state}):\n${logs.stdout}\n${logs.stderr}`);
}
async function snapshot() {
  const queries = (await client.query('SELECT id, "rawInput", origin, destination, active, "userId" FROM "Query" ORDER BY id')).rows;
  const prices = (await client.query('SELECT id, "queryId", price, currency, airline FROM "PriceSnapshot" ORDER BY id')).rows;
  const config = (await client.query('SELECT provider, model, "multiUserMode", "defaultCurrency", "scrapeInterval" FROM "ExtractionConfig"')).rows;
  return { queries, prices, config };
}
async function verify(base, fixture) {
  const access = accessStateSchema.parse((await client.query(`SELECT state FROM "SidedoorState" WHERE id = 'access'`)).rows[0].state);
  const owner = access.principals.find(principal => principal.role === 'owner');
  assert.ok(owner, 'An existing admin password must remain usable');
  const expectedPassword = fixture.gate ? gatePassword : password;
  assert.ok(await verifyPassword(expectedPassword, owner.passwordHash));
  const post = (action, body, cookie = '') => fetch(`${base}/api/access/${action}`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  const denied = await post('household', { password: 'incorrect-password' });
  assert.equal(denied.status, 401, 'Incorrect credentials must remain rejected');
  const admitted = await post('household', { password: expectedPassword });
  assert.equal(admitted.status, 200, `Historical password must admit the household: ${await admitted.text()}`);
  const cookie = admitted.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie.includes('ft-session='));
  const selected = await post('select-profile', { id: owner.id }, cookie);
  assert.equal(selected.status, 200, await selected.text());
  const identity = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).data.user.isAdmin, true);
  if (fixture.profiles) {
    assert.ok(access.principals.some(principal => principal.id === 'historical-owner' && principal.name === 'Owner' && principal.role === 'owner'));
    assert.ok(access.principals.some(principal => principal.id === 'historical-guest' && principal.name === 'Guest' && principal.role === 'member' && principal.passwordHash === null));
    const guest = await post('select-profile', { id: 'historical-guest' }, cookie);
    assert.equal(guest.status, 200, await guest.text());
    const guestIdentity = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(guestIdentity.status, 200);
    assert.equal((await guestIdentity.json()).data.user.isAdmin, false);
  }
  const credentials = credentialStateSchema.parse((await client.query(`SELECT state FROM "SidedoorState" WHERE id = 'provider-credentials'`)).rows[0].state);
  assert.equal(codec.resolveState(credentials, 'openai').apiKey, providerKey);
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM "SidedoorState" WHERE id = 'flight-finder-platform-cutover'`)).rows[0].count, 0);
  return access.principals.map(({ id, name, role }) => ({ id, name, role }));
}

try {
  await command('docker', ['network', 'create', prefix]);
  networkCreated = true;
  await command('docker', ['run', '-d', '--name', databaseContainer, '--network', prefix, '--network-alias', 'upgrade-db', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=upgrade-test-only', 'postgres:16-alpine']);
  databaseCreated = true;
  await command('docker', ['run', '-d', '--name', redisContainer, '--network', prefix, '--network-alias', 'upgrade-redis', 'redis:7-alpine']);
  redisCreated = true;
  const databasePort = (await command('docker', ['port', databaseContainer, '5432/tcp'])).split(':').at(-1);
  const connection = new URL(`postgresql://postgres:upgrade-test-only@127.0.0.1:${databasePort}/postgres`);
  admin = await waitForDatabase(connection.href);
  for (const fixture of cases) {
    const name = fixture.name.replaceAll('-', '_');
    await admin.query(`CREATE DATABASE "${name}"`);
    connection.pathname = `/${name}`;
    client = await waitForDatabase(connection.href);
    const source = await command('git', ['show', `${fixture.ref}:apps/web/prisma/schema.prisma`]);
    const schema = join(directory, `${name}.prisma`);
    await writeFile(schema, source.replace(/^\s*url\s*=\s*env\("DATABASE_URL"\)\s*$/m, ''));
    const sql = await command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema', schema, '--script']);
    assert.ok(sql.includes('CREATE TABLE'));
    await client.query(sql);
    const providerColumn = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ExtractionConfig' AND column_name = 'openaiApiKey'`)).rows.length > 0;
    await client.query(`INSERT INTO "ExtractionConfig" (id, provider, model, "updatedAt") VALUES ('singleton', 'openai', 'preserved-historical-model', now())`);
    if (!fixture.current) {
      await client.query('UPDATE "ExtractionConfig" SET "adminPasswordHash" = $1, "multiUserMode" = $2', [fixture.environment ? null : legacyHash(fixture.cost), Boolean(fixture.profiles)]);
      if (providerColumn) await client.query('UPDATE "ExtractionConfig" SET "openaiApiKey" = $1', [encryptSecret(providerKey)]);
      const nullable = (await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'passwordHash'`)).rows[0].is_nullable;
      assert.equal(nullable, fixture.ref === 'v0.10.0' ? 'NO' : 'YES');
    }
    if (fixture.profiles) {
      await client.query(`INSERT INTO "User" (id, username, "passwordHash", "isAdmin", "updatedAt") VALUES ('historical-owner', 'Owner', $1, TRUE, now()), ('historical-guest', 'Guest', NULL, FALSE, now())`, [legacyHash(fixture.cost)]);
    }
    await client.query(`INSERT INTO "Query" (id, "rawInput", origin, "originName", destination, "destinationName", "dateFrom", "dateTo", "expiresAt", active, "userId", "updatedAt") VALUES ('historical-flight', 'Preserved flight', 'LHR', 'London', 'JFK', 'New York', '2027-05-01', '2027-05-10', '2027-05-01', FALSE, $1, now())`, [fixture.profiles ? 'historical-owner' : null]);
    await client.query(`INSERT INTO "PriceSnapshot" (id, "queryId", "travelDate", price, currency, airline) VALUES ('historical-price', 'historical-flight', '2027-05-01', 321, 'GBP', 'Preserved airline')`);
    const before = await snapshot();
    const env = ['DATABASE_URL=postgresql://postgres:upgrade-test-only@upgrade-db:5432/' + name, 'REDIS_URL=redis://upgrade-redis:6379', 'SELF_HOSTED=true', 'INSTALL_CLI_PROVIDERS=false', 'CRON_ENABLED=false', `ADMIN_SESSION_SECRET=${sessionSecret}`, 'CRON_SECRET=upgrade-test-cron-secret'];
    if (!fixture.current) env.push(`SIDEDOOR_IMPORT_ADMIN_PASSWORD=${fixture.environment ? password : 'different-environment-admin-password'}`);
    if (!fixture.current && !providerColumn) env.push(`SIDEDOOR_IMPORT_OPENAI_API_KEY=${providerKey}`);
    if (fixture.gate) env.push(`SIDEDOOR_IMPORT_PASSWORD=${gatePassword}`);
    await command('docker', ['run', '-d', '--init', '--name', web, '--network', prefix, '-p', '127.0.0.1::3003', ...env.flatMap(value => ['-e', value]), image]);
    webCreated = true;
    let base = `http://${await command('docker', ['port', web, '3003/tcp'])}`;
    // Configure the exact published HTTP origin before exercising authentication.
    await waitForHealth(base);
    await client.query('UPDATE "ExtractionConfig" SET "publicBaseUrl" = $1', [base]);
    if (fixture.current) {
      assert.deepEqual((await client.query('SELECT id FROM "User"')).rows, []);
      const page = await fetch(`${base}/access`);
      assert.ok((await page.text()).includes('flight-finder access setup'), 'A fresh current schema must still require local owner setup');
      await command('python3', ['scripts/testing/access-setup.py', 'docker', 'exec', '-it', web, 'node', '/app/packages/cli/dist/index.js', 'access', 'setup'], { env: { ...process.env, TEST_ACCESS_NAME: 'CurrentOwner', TEST_ACCESS_PASSWORD: password } });
      const row = (await client.query(`SELECT state FROM "SidedoorState" WHERE id = 'provider-credentials'`)).rows[0];
      const credentials = credentialStateSchema.parse(row.state);
      codec.configureState(credentials, 'openai', { apiKey: providerKey });
      await client.query(`UPDATE "SidedoorState" SET state = $1::jsonb, revision = $2 WHERE id = 'provider-credentials'`, [JSON.stringify(credentials), randomUUID()]);
    }
    const principals = await verify(base, fixture);
    assert.deepEqual(await snapshot(), before, 'Upgrade must preserve tracker history, ownership and settings');
    await command('docker', ['restart', web]);
    base = `http://${await command('docker', ['port', web, '3003/tcp'])}`;
    await waitForHealth(base);
    await client.query('UPDATE "ExtractionConfig" SET "publicBaseUrl" = $1', [base]);
    assert.deepEqual(await verify(base, fixture), principals, 'Repeated startup must preserve profile identity');
    assert.deepEqual(await snapshot(), before, 'Repeated startup must preserve historical data');
    console.log(`PASS ${fixture.name}: ${fixture.ref}, startup, HTTP Admin access, provider decryption, histories, repeated startup`);
    await client.end();
    client = undefined;
    await command('docker', ['rm', '-f', '-v', web]);
    webCreated = false;
  }
} finally {
  await client?.end();
  await admin?.end();
  if (webCreated) await command('docker', ['rm', '-f', '-v', web]);
  if (redisCreated) await command('docker', ['rm', '-f', '-v', redisContainer]);
  if (databaseCreated) await command('docker', ['rm', '-f', '-v', databaseContainer]);
  if (networkCreated) await command('docker', ['network', 'rm', prefix]);
  await rm(directory, { recursive: true, force: true });
}
