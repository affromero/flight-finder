import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { admitBrowserHousehold } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Use disposable local services');
assert.ok(database.port && database.pathname === '/flight_forks', 'Use explicitly ported flight_forks');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD);
const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
assert.equal((await fetch(`${origin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: process.env.TEST_ACCESS_NAME }) })).status, 200);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ids = [randomUUID(), randomUUID()];
async function request(id, method = 'GET', body) {
  const response = await fetch(`${origin}/api/queries/${id}/alerts`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.match(response.headers.get('Cache-Control') ?? '', /private, no-store/);
  return { status: response.status, body: await response.json() };
}
try {
  const config = (await pool.query('SELECT enabled,"setupComplete" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false); assert.equal(config?.setupComplete, true);
  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  for (let index = 0; index < ids.length; index++) {
    await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","userId",currency,"updatedAt","firstViewedAt",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,now(),now(),false)',
      [ids[index], 'Price rules acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', '2027-06-15', '2027-06-20', owner.id, index === 0 ? 'USD' : null]);
    await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime","scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())',
      [randomUUID(), ids[index], '2027-06-15', 200, 'USD', 'Fixture Air', 'FixtureAir-FA100-JFK-LAX-2027-06-15', 'FA100', '08:00']);
  }
  const before = (await pool.query('SELECT "updatedAt" FROM "Query" WHERE id=$1', [ids[0]])).rows[0].updatedAt;
  const initial = await request(ids[0]); assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.data.settings.rules, []); assert.equal(initial.body.data.settings.revision, 0);
  const flight = initial.body.data.settings.flights[0]; assert.equal(flight.currency, 'USD');
  const created = await request(ids[0], 'PUT', { revision: 0, rules: [{ flightId: flight.id, currency: 'USD', targetPrice: 100 }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const settings = created.body.data.settings; assert.equal(settings.revision, 1);
  assert.equal((await request(ids[0], 'PUT', { revision: 1, rules: settings.rules })).body.data.settings.revision, 1);
  assert.equal((await request(ids[0], 'PUT', { revision: 0, rules: settings.rules })).status, 409);
  assert.equal((await request(ids[1], 'PUT', { revision: 0, rules: settings.rules })).status, 400, 'Foreign rule IDs are refused');
  assert.equal((await request(ids[0], 'PUT', { revision: 1, rules: [{ ...settings.rules[0], targetPrice: '100' }] })).status, 400);
  const concurrent = await Promise.all([110, 120].map(targetPrice => request(ids[0], 'PUT', { revision: 1, rules: [{ ...settings.rules[0], targetPrice }] })));
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const current = concurrent.find(response => response.status === 200).body.data.settings;
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime",status,"scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())',
    [randomUUID(), ids[0], '2027-06-15', 200, 'USD', 'Fixture Air', flight.id, 'FA100', '08:00', 'sold_out']);
  const paused = await request(ids[0], 'PUT', { revision: current.revision, rules: current.rules.map(rule => ({ ...rule, enabled: false })) });
  assert.equal(paused.status, 200, 'An unavailable flight must not prevent pausing its rule');
  assert.equal(paused.body.data.settings.rules[0].enabled, false);
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime","scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())',
    [randomUUID(), ids[1], '2027-06-15', 180, 'EUR', 'Fixture Air', flight.id, 'FA100', '08:00']);
  const mixed = (await request(ids[1])).body.data.settings;
  assert.equal(mixed.currency, 'EUR');
  assert.deepEqual(mixed.flights.map(flight => flight.currency).sort(), ['EUR', 'USD']);
  const explicit = await request(ids[1], 'PUT', { revision: 0, rules: [{ flightId: flight.id, currency: 'USD', targetPrice: 100 }] });
  assert.equal(explicit.status, 200, 'A valid explicit-currency flight rule must not depend on the auto comparison anchor');
  assert.equal(explicit.body.data.settings.rules[0].currency, 'USD');
  const after = (await pool.query('SELECT "updatedAt" FROM "Query" WHERE id=$1', [ids[0]])).rows[0].updatedAt;
  assert.equal(after.toISOString(), before.toISOString(), 'Rule edits do not change scrape criteria authority');
  console.log('Price-rule production API/PostgreSQL acceptance passed: private responses, server IDs, unchanged criteria, no-op revisions, conflicts, concurrent edits, foreign IDs, malformed thresholds, pausing unavailable flights and mixed-currency flight choices.');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=ANY($1)', [ids]);
  await pool.end();
}
