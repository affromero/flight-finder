import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Disposable local-only upgrade/rollback rehearsal. No production credentials,
// personal data, existing databases or existing containers are modified.
process.umask(0o077);
const root = fileURLToPath(new URL('..', import.meta.url));
const connection = new URL(process.env.TRAVEL_TEST_DATABASE_URL ?? 'postgresql://car_test:car-local-test@127.0.0.1:55440/car_test');
assert.equal(connection.hostname, '127.0.0.1');
assert.equal(connection.port, '55440');
assert.equal(connection.pathname, '/car_test');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const database = `car_migration_${suffix}`;
const container = `flight-finder-car-rollback-${suffix}`;
const image = process.env.TRAVEL_ROLLBACK_IMAGE ?? 'flight-finder-hotel-review:final';
const base = process.env.TRAVEL_BASE_REF ?? 'b15f4c4';
assert.match(base, /^[a-zA-Z0-9_./-]+$/);
const output = await mkdtemp(join(tmpdir(), 'flight-finder-travel-migration-'));
const baselineSchema = join(output, 'baseline.prisma');
const expandedSchema = join(output, 'expanded.prisma');
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
  await writeFile(expandedSchema, await readFile(resolve(root, 'apps/web/prisma/schema.prisma')));
  // The schema contains no secrets. Linux's container UID differs from the
  // host UID, so this read-only bind mount must be readable by the node user.
  await chmod(expandedSchema, 0o644);
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
  for (const table of ['User', 'ExtractionConfig', 'Query', 'FetchRun', 'PriceSnapshot', 'HotelTracker', 'HotelSearchRun', 'HotelSnapshot', 'HotelAlert']) {
    tables[table] = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = $1 ORDER BY ordinal_position', [table])).rows.map(row => row.column_name);
  }
  const before = await snapshot(tables);
  const constraints = await readFile(resolve(root, 'apps/web/prisma/travel-constraints.sql'), 'utf8');
  await push(expandedSchema); await client.query(constraints);
  await push(expandedSchema); await client.query(constraints);
  assert.equal(await snapshot(tables), before, 'Idempotent upgrade must preserve every existing column and row');
  assert.equal((await client.query('SELECT "carPreferencesRevision" FROM "User" WHERE id = $1', ['migration-owner'])).rows[0].carPreferencesRevision, 0, 'Existing accounts start with preference revision zero');
  await client.query(`
    INSERT INTO "CarTracker" (id, label, search, currency, "latestPriceMinor", "updatedAt") VALUES ('migration-car', 'New car data survives rollback', '{}', 'USD', 9365, now());
    INSERT INTO "CarTrackerCreation" (id, "requestHash", "trackerId") VALUES (repeat('b',64), repeat('c',64), 'migration-car');
    INSERT INTO "CarSearchRun" (id, "trackerId", request, status, "completedAt") VALUES ('migration-car-run', 'migration-car', '{}', 'success', now());
    INSERT INTO "CarSearchRun" (id, request, status, "completedAt", "trackingClosed") VALUES ('migration-car-closed', '{}', 'success', now(), true);
    INSERT INTO "CarSnapshot" (id, "trackerId", "runId", source, offer, currency, "totalMinor", eligible, "contractHash", "observedAt")
      VALUES ('migration-car-price', 'migration-car', 'migration-car-run', 'autoeurope', '{"totalMinor":9365}', 'USD', 9365, true, repeat('a',64), now());
    INSERT INTO "TravelJob" (id, kind, status, "carRunId", "completedAt") VALUES ('migration-job', 'car_search', 'succeeded', 'migration-car-run', now());
    INSERT INTO "TravelAlertDelivery" (id, "carTrackerId", "eventKey", message, "deliveredIds")
      VALUES ('migration-car-alert', 'migration-car', 'migration-alert', '{"title":"Pending car alert"}', ARRAY['delivered-test-channel']);
  `);
  assert.equal((await client.query('SELECT "trackingClosed" FROM "CarSearchRun" WHERE id = $1', ['migration-car-run'])).rows[0].trackingClosed, false, 'New searches start open for tracking');
  const newTables = {};
  await client.query('UPDATE "User" SET "preferredCarProviders" = ARRAY[\'autoeurope\']::"CarProvider"[], "carPreferencesRevision" = 2 WHERE id = $1', ['migration-owner']);
  newTables.User = ['id', 'preferredCarProviders', 'carPreferencesRevision'];
  for (const table of ['CarTracker', 'CarTrackerCreation', 'CarSearchRun', 'CarSnapshot', 'TravelJob', 'TravelAlertDelivery']) {
    newTables[table] = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = $1 ORDER BY ordinal_position', [table])).rows.map(row => row.column_name);
  }
  const newBefore = await snapshot(newTables);

  // An old runtime keeps its old generated client but receives the additive
  // schema read-only, preventing its startup db push from dropping new tables.
  const dockerConnection = new URL(connection); dockerConnection.hostname = 'host.docker.internal';
  await command('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::3003',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '--mount', `type=bind,src=${expandedSchema},dst=/app/apps/web/prisma/schema.prisma,readonly`,
    '-e', `DATABASE_URL=${dockerConnection.href}`, '-e', 'REDIS_URL=redis://host.docker.internal:56389',
    '-e', 'SELF_HOSTED=true', '-e', 'CRON_ENABLED=false', '-e', 'INSTALL_CLI_PROVIDERS=false',
    '-e', 'ADMIN_SESSION_SECRET=local-migration-test-session-secret',
    '-e', 'CRON_SECRET=local-migration-test-cron-secret', imageId]);
  appStarted = true;
  const portMapping = (await command('docker', ['port', container, '3003/tcp'])).trim();
  assert.match(portMapping, /^127\.0\.0\.1:\d+$/);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://${portMapping}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) { ready = true; break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  const logs = await command('docker', ['logs', container]);
  await writeFile(join(output, 'rollback.log'), logs);
  assert.ok(ready, `Old runtime did not become healthy:\n${logs}`);
  assert.equal(await snapshot(tables), before, 'Old runtime restart must preserve histories, ownership, settings and pending delivery state');
  assert.equal(await snapshot(newTables), newBefore, 'New car prices, jobs and pending deliveries must survive the old runtime restart');
  await assert.rejects(client.query(`INSERT INTO "TravelJob" (id, kind) VALUES ('invalid-after-rollback', 'car_search')`), /check constraint/);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, database, base, image, imageId, stages: ['baseline', 'upgrade', 'repeat-upgrade', 'old-runtime-with-expanded-schema', 'row-preservation'] }, null, 2));
  console.log(`PASS travel upgrade and old-runtime rollback; private evidence: ${output}; retained disposable database: ${database}`);
} finally {
  try { if (appStarted) await command('docker', ['stop', container]); }
  finally { await client?.end(); }
}
