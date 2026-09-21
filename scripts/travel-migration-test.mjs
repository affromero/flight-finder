import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Disposable local-only migration rehearsal. No production credentials,
// personal data, existing databases or existing containers are modified.
process.umask(0o077);
const root = fileURLToPath(new URL('..', import.meta.url));
const connection = new URL(process.env.TRAVEL_TEST_DATABASE_URL ?? 'postgresql://car_test:car-local-test@127.0.0.1:55440/car_test');
assert.equal(connection.hostname, '127.0.0.1');
assert.equal(connection.port, '55440');
assert.equal(connection.pathname, '/car_test');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const database = `car_migration_${suffix}`;
const container = `flight-finder-travel-migration-${suffix}`;
const image = process.env.TRAVEL_MIGRATION_IMAGE ?? 'flight-finder-travel-migration:test';
const base = process.env.TRAVEL_BASE_REF ?? 'b15f4c4';
assert.match(base, /^[a-zA-Z0-9_./-]+$/);
const output = await mkdtemp(join(tmpdir(), 'flight-finder-travel-migration-'));
const baselineSchema = join(output, 'baseline.prisma');
let appStarted = false;
let client;

async function command(executable, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: root, env: process.env, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolveCommand(stdout);
      else reject(new Error(`${executable} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}
async function push(schema) {
  await command(process.execPath, [resolve(root, 'node_modules/prisma/build/index.js'), 'db', 'push', `--schema=${schema}`, `--url=${connection.href}`]);
}
async function snapshot(tables) {
  const rows = {};
  for (const [table, columns] of Object.entries(tables)) {
    const selected = columns.map(c => `"${c}"`).join(',');
    rows[table] = (await client.query(`SELECT ${selected} FROM "${table}" ORDER BY id`)).rows;
  }
  return JSON.stringify(rows);
}
async function waitForHealth(portMapping) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://${portMapping}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  const logs = await command('docker', ['logs', container]);
  throw new Error(`Migration target did not become healthy:\n${logs}`);
}
try {
  const imageId = (await command('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const admin = new pg.Client({ connectionString: connection.href });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${database}"`); } finally { await admin.end(); }
  connection.pathname = `/${database}`;
  client = new pg.Client({ connectionString: connection.href });
  await client.connect();
  await writeFile(baselineSchema, await command('git', ['show', `${base}:apps/web/prisma/schema.prisma`]));
  await push(baselineSchema);
  await client.query(`
    INSERT INTO "User" (id, username, "updatedAt") VALUES ('migration-owner', 'migration-owner', now());
    INSERT INTO "ExtractionConfig" (id, provider, model, "scrapeInterval", "defaultCurrency", "updatedAt")
      VALUES ('singleton', 'anthropic', 'preserved-flight-model', 6, 'GBP', now());
    INSERT INTO "Query" (id, "rawInput", origin, "originName", destination, "destinationName", "dateFrom", "dateTo", "expiresAt", "cabinClass", currency, "vpnCountries", "userId", "updatedAt")
      VALUES ('migration-flight', 'Preservation sentinel', 'LHR', 'London', 'JFK', 'New York', '2027-05-01', '2027-05-10', '2027-05-01', 'business', 'GBP', ARRAY['DE'], 'migration-owner', now());
    INSERT INTO "FetchRun" (id, "queryId", status, "snapshotsCount") VALUES ('migration-flight-run', 'migration-flight', 'success', 1);
    INSERT INTO "PriceSnapshot" (id, "queryId", "fetchRunId", "travelDate", price, currency, airline) VALUES ('migration-flight-price', 'migration-flight', 'migration-flight-run', '2027-05-01', 321, 'GBP', 'Example airline');
    INSERT INTO "HotelTracker" (id, "userId", "hotelName", search, selection, options, "targetArmed", "historicalLow", "latestPrice", "updatedAt")
      VALUES ('migration-hotel', 'migration-owner', 'Preserved hotel', '{}', '{}', '{}', false, 650, 700, now());
    INSERT INTO "HotelSearchRun" (id, "userId", "trackerId", request, status) VALUES ('migration-hotel-run', 'migration-owner', 'migration-hotel', '{}', 'success');
    INSERT INTO "HotelSnapshot" (id, "trackerId", "runId", offer, eligible) VALUES ('migration-hotel-price', 'migration-hotel', 'migration-hotel-run', '{"totalPrice":650}', true);
    INSERT INTO "HotelAlert" (id, "trackerId", message, "deliveredIds", pending) VALUES ('migration-hotel-alert', 'migration-hotel', '{"title":"Pending hotel alert"}', ARRAY['already-delivered-channel'], true);
  `);
  const tables = {};
  const movedCredentialColumns = new Set(['passwordHash', 'adminPasswordHash', 'anthropicApiKey', 'openaiApiKey', 'googleApiKey']);
  for (const table of ['User', 'ExtractionConfig', 'Query', 'FetchRun', 'PriceSnapshot', 'HotelTracker', 'HotelSearchRun', 'HotelSnapshot', 'HotelAlert']) {
    tables[table] = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = $1 ORDER BY ordinal_position', [table])).rows.map(row => row.column_name).filter(column => !movedCredentialColumns.has(column));
  }
  const before = await snapshot(tables);
  const dockerConnection = new URL(connection); dockerConnection.hostname = 'host.docker.internal';
  await command('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::3003',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '-e', `DATABASE_URL=${dockerConnection.href}`, '-e', 'REDIS_URL=redis://host.docker.internal:56389',
    '-e', 'SELF_HOSTED=true', '-e', 'CRON_ENABLED=false', '-e', 'INSTALL_CLI_PROVIDERS=false',
    '-e', 'ADMIN_SESSION_SECRET=local-migration-test-session-secret',
    '-e', 'SIDEDOOR_IMPORT_ADMIN_PASSWORD=local-migration-owner-password',
    '-e', 'CRON_SECRET=local-migration-test-cron-secret', imageId]);
  appStarted = true;
  const portMapping = (await command('docker', ['port', container, '3003/tcp'])).trim();
  assert.match(portMapping, /^127\.0\.0\.1:\d+$/);
  await waitForHealth(portMapping);
  const logs = await command('docker', ['logs', container]);
  await writeFile(join(output, 'migration.log'), logs);
  assert.equal(await snapshot(tables), before, 'Migration must preserve histories, ownership, settings and pending delivery state');
  assert.equal((await client.query('SELECT "carPreferencesRevision" FROM "User" WHERE id = $1', ['migration-owner'])).rows[0].carPreferencesRevision, 0, 'Existing accounts start with preference revision zero');
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND column_name = ANY($1)`, [[...movedCredentialColumns]])).rows[0].count, 0, 'Moved credential columns must be removed');
  assert.ok((await client.query(`SELECT state FROM "SidedoorState" WHERE id = 'access'`)).rows[0]?.state, 'Access state must be created before source credentials are removed');

  await client.query(`
    INSERT INTO "CarTracker" (id, label, search, currency, "latestPriceMinor", "updatedAt") VALUES ('migration-car', 'New car data survives restart', '{}', 'USD', 9365, now());
    INSERT INTO "CarTrackerCreation" (id, "requestHash", "trackerId") VALUES (repeat('b',64), repeat('c',64), 'migration-car');
    INSERT INTO "CarSearchRun" (id, "trackerId", request, status, "completedAt") VALUES ('migration-car-run', 'migration-car', '{}', 'success', now());
    INSERT INTO "CarSnapshot" (id, "trackerId", "runId", source, offer, currency, "totalMinor", eligible, "contractHash", "observedAt")
      VALUES ('migration-car-price', 'migration-car', 'migration-car-run', 'autoeurope', '{"totalMinor":9365}', 'USD', 9365, true, repeat('a',64), now());
    INSERT INTO "TravelJob" (id, kind, status, "carRunId", "completedAt") VALUES ('migration-job', 'car_search', 'succeeded', 'migration-car-run', now());
  `);
  const currentData = await snapshot({ CarTracker: ['id', 'label', 'latestPriceMinor'], CarSearchRun: ['id', 'trackerId', 'status'], CarSnapshot: ['id', 'trackerId', 'totalMinor'], TravelJob: ['id', 'kind', 'status'] });
  await command('docker', ['restart', container]);
  await waitForHealth(portMapping);
  assert.equal(await snapshot(tables), before, 'Repeated startup must preserve migrated data');
  assert.equal(await snapshot({ CarTracker: ['id', 'label', 'latestPriceMinor'], CarSearchRun: ['id', 'trackerId', 'status'], CarSnapshot: ['id', 'trackerId', 'totalMinor'], TravelJob: ['id', 'kind', 'status'] }), currentData, 'Repeated startup must preserve current data');
  await assert.rejects(client.query(`INSERT INTO "TravelJob" (id, kind) VALUES ('invalid-after-migration', 'car_search')`), /check constraint/);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, database, base, image, imageId, stages: ['source-schema', 'credential-extraction', 'schema-migration', 'current-runtime', 'repeat-startup', 'row-preservation'] }, null, 2));
  console.log(`PASS travel migration and repeat startup; private evidence: ${output}; retained disposable database: ${database}`);
} finally {
  try { if (appStarted) await command('docker', ['stop', container]); }
  finally { await client?.end(); }
}
