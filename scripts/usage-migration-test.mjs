import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const adminUrl = new URL(process.env.SIDEDOOR_TEST_DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname));
assert.equal(adminUrl.pathname, '/sidedoor_test');
const database = `sidedoor_usage_${crypto.randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'sidedoor-usage-migration-'));
const admin = new pg.Client({ connectionString: adminUrl.href });
const target = new URL(adminUrl);
target.pathname = `/${database}`;
let client;
let created = false;
const baseline = `datasource db {
  provider = "postgresql"
}
model ApiUsageLog {
  id String @id @default(cuid())
  provider String
  model String
  inputTokens Int
  outputTokens Int
  costUsd Float
  operation String
  durationMs Int
  error String?
  createdAt DateTime @default(now())
  @@index([createdAt])
  @@index([provider])
}
`;
async function push(name, schema) {
  const path = join(directory, name);
  await writeFile(path, schema);
  const result = spawnSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', `--schema=${path}`], {
    env: { ...process.env, DATABASE_URL: target.href }, encoding: 'utf8', timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  client = new pg.Client({ connectionString: target.href });
  await client.connect();
  await push('before.prisma', baseline);
  await client.query(`INSERT INTO "ApiUsageLog" (id,provider,model,"inputTokens","outputTokens","costUsd",operation,"durationMs")
    VALUES ('historical-measured','example','old-model',100,20,0.12,'extract',30),
      ('historical-zero','example','old-model',0,0,0,'extract',12)`);
  const before = (await client.query('SELECT * FROM "ApiUsageLog" ORDER BY id')).rows;
  const current = await readFile('apps/web/prisma/schema.prisma', 'utf8');
  const model = current.match(/^model ApiUsageLog \{[\s\S]*?^\}/m)?.[0];
  assert.ok(model);
  const expanded = `datasource db {\n provider = "postgresql"\n}\n${model}\n`;
  await push('after.prisma', expanded);
  await push('after.prisma', expanded);
  const rows = (await client.query('SELECT * FROM "ApiUsageLog" ORDER BY id')).rows;
  for (let i = 0; i < before.length; i++) {
    for (const key of Object.keys(before[i])) assert.deepEqual(rows[i][key], before[i][key]);
    assert.equal(rows[i].cachedInputTokens, null);
    assert.equal(rows[i].cacheWriteTokens, null);
    assert.equal(rows[i].reasoningTokens, null);
  }
  await client.query(`INSERT INTO "ApiUsageLog" (id,provider,model,"inputTokens","outputTokens","costUsd",operation,"durationMs")
    VALUES ('unknown','example','new-model',NULL,NULL,NULL,'extract',40)`);
  const totals = (await client.query('SELECT count(*)::int AS total, count("costUsd")::int AS known, sum("costUsd") AS subtotal FROM "ApiUsageLog"')).rows[0];
  assert.deepEqual(totals, { total: 3, known: 2, subtotal: 0.12 });
  process.stdout.write('Usage upgrade preserved historical rows, accepts unknown measurements, and distinguishes incomplete totals.\n');
} finally {
  await client?.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
