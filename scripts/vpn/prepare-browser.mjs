import assert from 'node:assert/strict';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55448'); assert.ok(['/flight_forks', '/vpn_browser_test'].includes(database.pathname));
const pool = new pg.Pool({ connectionString: database.href });
try {
  await pool.query('INSERT INTO "ExtractionConfig" (id,"setupComplete",enabled,"updatedAt") VALUES ($1,true,false,now()) ON CONFLICT (id) DO UPDATE SET "setupComplete"=true,enabled=false', ['singleton']);
} finally { await pool.end(); }
