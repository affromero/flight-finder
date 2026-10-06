import assert from 'node:assert/strict';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55448'); assert.equal(database.pathname, '/parse_browser_test');
const pool = new pg.Pool({ connectionString: database.href });
try {
  await pool.query('INSERT INTO "ExtractionConfig" (id,"setupComplete",enabled,"multiUserMode","updatedAt") VALUES ($1,true,false,true,now()) ON CONFLICT (id) DO UPDATE SET "setupComplete"=true,enabled=false,"multiUserMode"=true', ['singleton']);
} finally { await pool.end(); }
