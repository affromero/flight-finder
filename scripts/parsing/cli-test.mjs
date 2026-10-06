import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('../../', import.meta.url));
const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55448'); assert.equal(database.pathname, '/parse_browser_test');
const pool = new pg.Pool({ connectionString: database.href });
let held = false;
const requests = [], pending = [], children = [];
const provider = createServer(async (request, response) => {
  let bytes = ''; for await (const chunk of request) bytes += String(chunk);
  requests.push(JSON.parse(bytes));
  if (held) { pending.push(response); return; }
  const result = { confidence: 'medium', parsed: null, ambiguities: [{ field: 'date', question: 'Which date?', options: ['Friday', 'Saturday'] }] };
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ id: 'fixture', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
});
async function waitFor(condition) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('CLI parsing fixture did not settle');
}
function launch(args, extra = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, REDIS_URL: '', CRON_ENABLED: 'false', FLIGHT_FINDER_SESSION: '', FLIGHT_FINDER_TOKEN: '', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('CLI process timeout: ' + stderr)); }, 25_000);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, result };
}
const command = (...args) => launch([join(root, 'packages/cli/dist/index.js'), ...args]);
try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const fixture = await launch(['--import', 'tsx', 'apps/web/src/test/parsing/cli-fixture.ts', `http://127.0.0.1:${address.port}/v1`], { TSX_TSCONFIG_PATH: join(root, 'apps/web/tsconfig.json') }).result;
  assert.equal(fixture.code, 0, fixture.stderr); const { ownerId } = JSON.parse(fixture.stdout);
  const sync = await command('parse', 'JFK to LAX tomorrow', '--json').result;
  assert.equal(sync.code, 0, sync.stderr); assert.equal(JSON.parse(sync.stdout).confidence, 'medium');
  assert.equal(Number((await pool.query('SELECT count(*) FROM "ParseJob"')).rows[0].count), 0);
  const async = await command('parse', 'JFK to LAX Friday', '--mode', 'async', '--json').result;
  assert.equal(async.code, 0, async.stderr); assert.equal(JSON.parse(async.stdout).confidence, 'medium');
  const completed = (await pool.query('SELECT * FROM "ParseJob"')).rows;
  assert.equal(completed.length, 1); assert.equal(completed[0].ownerId, ownerId); assert.equal(completed[0].status, 'completed');
  assert.equal(Number((await pool.query('SELECT count(*) FROM "ApiUsageLog"')).rows[0].count), 2);
  assert.equal(Number((await pool.query('SELECT count(*) FROM "ParseReservation" WHERE "settledAt" IS NULL')).rows[0].count), 0);
  const before = requests.length;
  const dedup = await command('parse', 'JFK to LAX Friday', '--mode', 'async', '--json').result;
  assert.equal(dedup.code, 0, dedup.stderr); assert.equal(requests.length, before);

  // A competing owner's queued work must remain untouched by a command-local worker.
  await pool.query('INSERT INTO "ParseJob" (id,"actorScope","ipHash","dedupKey",input,provider,"configFingerprint","promptDate","expiresAt","queueUntil","updatedAt") VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now()+interval \'1 day\',now()+interval \'10 minutes\',now())', ['unrelated-cli-fixture', 'cap:unrelated', 'unrelated', 'unrelated', JSON.stringify({ query: 'Unrelated private request' }), 'ollama', 'unrelated', '2026-10-06']);
  held = true; const count = requests.length;
  const cancelled = command('parse', 'JFK to LAX cancelled locally', '--mode', 'async', '--json');
  await waitFor(() => requests.length > count);
  const running = (await pool.query('SELECT id FROM "ParseJob" WHERE status=\'running\'')).rows;
  assert.equal(running.length, 1);
  cancelled.child.kill('SIGINT');
  const stopped = await cancelled.result; assert.equal(stopped.code, 130, stopped.stderr); assert.match(stopped.stderr, /"error":.*cancelled/i);
  assert.equal((await pool.query('SELECT status FROM "ParseJob" WHERE id=$1', [running[0].id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM "ParseJob" WHERE id=$1', ['unrelated-cli-fixture'])).rows[0].status, 'queued');
  assert.equal(Number((await pool.query('SELECT count(*) FROM "ParseReservation" WHERE "settledAt" IS NULL')).rows[0].count), 0);
  await waitFor(() => pending.every(response => response.destroyed));
  assert.equal(JSON.stringify(requests.at(-1)).includes('Unrelated private request'), false);
  await pool.query('DELETE FROM "ParseJob" WHERE id=$1', ['unrelated-cli-fixture']);
  const interactiveCount = requests.length;
  const interactive = spawn('python3', [join(root, 'scripts/parsing/wizard-test.py'), process.execPath, join(root, 'packages/cli/dist/index.js')], {
    cwd: root, env: { ...process.env, REDIS_URL: '', CRON_ENABLED: 'false', FLIGHT_FINDER_SESSION: '', FLIGHT_FINDER_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(interactive);
  let interactiveOutput = '', interactiveError = '';
  interactive.stdout.on('data', chunk => { interactiveOutput += chunk; }); interactive.stderr.on('data', chunk => { interactiveError += chunk; });
  const interactiveExit = once(interactive, 'exit');
  try { await waitFor(() => requests.length > interactiveCount); }
  catch (error) { throw Error('Interactive parsing did not reach the provider: ' + interactiveError + interactiveOutput, { cause: error }); }
  interactive.stdin.write('cancel\n');
  assert.equal((await interactiveExit)[0], 0, interactiveError);
  const interactiveResult = JSON.parse(interactiveOutput); assert.equal(interactiveResult.code, 0, interactiveResult.output);
  assert.match(interactiveResult.output, /Parsing your query/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM "ParseReservation" WHERE "settledAt" IS NULL')).rows[0].count), 0);
  assert.equal((await pool.query('SELECT status FROM "ParseJob" WHERE input->>\'query\'=$1', ['JFK to LAX interrupted interactive'])).rows[0].status, 'cancelled');
  const lock = await pool.connect();
  try {
    const count = requests.length;
    const uncertain = command('parse', 'JFK to LAX uncertain cleanup', '--mode', 'async', '--json');
    await waitFor(() => requests.length > count);
    await lock.query('BEGIN'); await lock.query('LOCK TABLE "ParseReservation" IN ACCESS EXCLUSIVE MODE');
    uncertain.child.kill('SIGINT');
    const stopped = await uncertain.result;
    assert.equal(stopped.code, 130, stopped.stderr); assert.equal(stopped.stdout, ''); assert.match(stopped.stderr, /"error":.*Could not confirm cancellation/);
    await lock.query('ROLLBACK');
    assert.equal(Number((await pool.query('SELECT count(*) FROM "ParseReservation" WHERE "settledAt" IS NULL')).rows[0].count), 1);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  held = false;
  const late = await launch(['--import', 'tsx', 'apps/web/src/test/parsing/cli-fixture.ts', `http://127.0.0.1:${address.port}/v1`, 'cancel-completed'], { TSX_TSCONFIG_PATH: join(root, 'apps/web/tsconfig.json') }).result;
  assert.equal(late.code, 0, late.stderr); assert.equal(JSON.parse(late.stdout).cancelledBeforeAcceptance, true);
  console.log('PASS packaged standalone sync/async parsing, canonical owner, deduplication, targeted claims and SIGINT settlement without a web worker');
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  for (const response of pending) response.destroy();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await pool.query('DELETE FROM "ParseJob"'); await pool.query('DELETE FROM "ParseReservation"'); await pool.end();
}
