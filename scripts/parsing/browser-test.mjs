import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:3411';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55448'); assert.equal(database.pathname, '/parse_browser_test');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD);
const pool = new pg.Pool({ connectionString: database.href });
const beforeDirectory = process.env.PARSE_BROWSER_BEFORE_DIRECTORY;
const errors = [];
let web, browser, token, headers, memberId;
let serverOutput = '';
let hold = false;
let malformed = false;
const requests = [];
const pending = [];
const provider = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] })); return;
  }
  let bytes = '';
  for await (const chunk of request) bytes += String(chunk);
  requests.push(JSON.parse(bytes));
  if (hold) { pending.push(response); return; }
  const result = { confidence: 'medium', parsed: { origins: [{ code: 'JFK', name: 'New York' }], destinations: [{ code: 'LAX', name: 'Los Angeles' }], dateFrom: '2026-10-07', dateTo: '2026-10-07', cabinClass: 'economy', tripType: 'one_way' }, ambiguities: [{ field: 'date', question: 'Which departure date?', options: ['Friday', 'Saturday'] }] };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: 'fixture', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: malformed ? 'private fixture response' : JSON.stringify(result) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
});
async function waitFor(work, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Parse browser fixture did not settle: ' + serverOutput);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(timer); }
}
async function startWeb(directory = root) {
  serverOutput = '';
  web = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--port', '3411', '--hostname', '127.0.0.1'], {
    cwd: join(directory, 'apps/web'), env: { ...process.env, NODE_ENV: 'production', SELF_HOSTED: 'true', CRON_ENABLED: 'false', REDIS_URL: '', APP_URL: origin }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', chunk => { serverOutput += chunk; }); web.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitFor(async () => {
    if (web.exitCode !== null) throw Error('Production parser exited: ' + serverOutput);
    try { return (await fetch(origin + '/api/health')).ok; } catch { return false; }
  });
}
async function api(path, body, options = {}) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
  const data = await response.json();
  return { response, data };
}
async function save(fields) {
  const current = await api('/api/admin/config'); assert.equal(current.response.status, 200, JSON.stringify(current.data));
  const next = await api('/api/admin/config', { ...fields, expectedRevision: current.data.data.providerRevision, expectedUpdatedAt: current.data.data.updatedAt }, { method: 'PATCH' });
  assert.equal(next.response.status, 200, JSON.stringify(next.data));
}
async function signIn(username) {
  const admitted = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
  const nextHeaders = { 'Content-Type': 'application/json', Origin: origin, Cookie: 'ft-session=' + admitted };
  const selected = await fetch(origin + '/api/auth/login', { method: 'POST', headers: nextHeaders, body: JSON.stringify({ username }) });
  assert.equal(selected.status, 200, await selected.text());
  return { token: admitted, headers: nextHeaders };
}
async function privateStatus(id, authority = headers) {
  return api('/api/parse/' + id, undefined, { headers: authority });
}
async function settled() {
  try { await waitFor(async () => {
    const jobs = Number((await pool.query('SELECT count(*) FROM "ParseJob" WHERE status IN (\'queued\',\'running\')')).rows[0].count);
    const reservations = Number((await pool.query('SELECT count(*) FROM "ParseReservation" WHERE "settledAt" IS NULL')).rows[0].count);
    return jobs === 0 && reservations === 0;
  }); }
  catch (error) {
    const jobs = (await pool.query('SELECT id,status,error,"leaseUntil" FROM "ParseJob"')).rows;
    const reservations = (await pool.query('SELECT "jobId","leaseUntil","quarantinedAt","settledAt" FROM "ParseReservation"')).rows;
    throw Error(JSON.stringify({ jobs, reservations }), { cause: error });
  }
}
try {
  const config = (await pool.query('SELECT enabled,"setupComplete" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false); assert.equal(config?.setupComplete, true);
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  await startWeb(beforeDirectory ?? root);
  ({ token, headers } = await signIn(process.env.TEST_ACCESS_NAME));
  await save({ provider: 'ollama', model: 'fixture', customBaseUrl: `http://127.0.0.1:${address.port}/v1`, defaultSearchMethod: 'ai' });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.setDefaultTimeout(15_000); await addBrowserSession(context, origin, token);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
  await page.goto(origin + '/');
  const input = page.getByPlaceholder('NYC to Paris around June 15 +/- 3 days'); await input.waitFor();
  const search = input.locator('xpath=../..');
  const screenshots = join(root, 'docs/contributors/screenshots'); await mkdir(screenshots, { recursive: true });
  if (beforeDirectory) {
    await search.screenshot({ path: join(screenshots, 'flight-parse-before.png') });
    console.log('PASS baseline flight parsing screenshot');
  } else {
    assert.equal(await page.getByRole('checkbox', { name: 'Parse in the background' }).isChecked(), false);
    await input.fill('JFK to LAX tomorrow');
    const sync = page.waitForResponse(response => response.url().endsWith('/api/parse') && response.request().method() === 'POST');
    await input.press('Enter'); assert.equal((await sync).status(), 200);
    await page.getByRole('group', { name: 'Which departure date?' }).waitFor();
    assert.equal(Number((await pool.query('SELECT count(*) FROM "ParseJob"')).rows[0].count), 0);
    await page.reload(); await page.getByRole('checkbox', { name: 'Parse in the background' }).check();
    await input.fill('JFK to LAX Friday');
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/parse') && response.status() === 202);
    await input.press('Enter'); const job = (await (await accepted).json()).data;
    assert.equal(job.capability, undefined);
    await page.getByRole('group', { name: 'Which departure date?' }).waitFor();
    assert.equal((await privateStatus(job.id)).data.data.status, 'completed');
    const dedup = await api('/api/parse', { query: 'JFK to LAX Friday', mode: 'async' }); assert.equal(dedup.data.data.id, job.id);
    await search.screenshot({ path: join(screenshots, 'flight-parse-desktop.png') });

    const memberName = 'ParseBrowserMember' + process.pid;
    const created = await api('/api/admin/users', { username: memberName }); assert.equal(created.response.status, 201, JSON.stringify(created.data));
    memberId = created.data.data.user.id;
    const member = await signIn(memberName);
    assert.equal((await privateStatus(job.id, member.headers)).response.status, 404);
    assert.equal((await api('/api/parse/' + job.id, undefined, { method: 'DELETE', headers: member.headers })).response.status, 404);
    assert.equal((await api('/api/admin/parse', undefined, { headers: member.headers })).response.status, 403);
    const memberJob = await api('/api/parse', { query: 'JFK to LAX Friday', mode: 'async' }, { headers: member.headers });
    assert.equal(memberJob.response.status, 202); assert.notEqual(memberJob.data.data.id, job.id);
    assert.equal((await privateStatus(memberJob.data.data.id)).response.status, 404);
    await waitFor(async () => (await privateStatus(memberJob.data.data.id, member.headers)).data.data.status === 'completed');

    // An admitted household without a selected profile exercises guest capabilities.
    const guestToken = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
    const guest = { ...headers, Cookie: 'ft-session=' + guestToken };
    const anonymous = await api('/api/parse', { query: 'JFK to LAX Saturday', mode: 'async' }, { headers: guest });
    assert.equal(anonymous.response.status, 202); assert.match(anonymous.data.data.capability, /^[a-f0-9]{64}$/);
    const capability = { ...guest, 'X-Parse-Capability': anonymous.data.data.capability };
    const denied = await privateStatus(anonymous.data.data.id, guest); assert.equal(denied.response.status, 404); assert.equal(denied.response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await privateStatus(job.id, capability)).response.status, 404);
    await waitFor(async () => (await privateStatus(anonymous.data.data.id, capability)).data.data.status === 'completed');
    assert.equal((await api('/api/parse', { query: 'JFK to LAX Saturday', mode: 'async' }, { headers: capability })).data.data.id, anonymous.data.data.id);
    assert.equal((await api('/api/parse', { query: 'JFK to LAX Saturday', mode: 'async' }, { headers: guest })).data.data.id === anonymous.data.data.id, false);
    await settled();

    hold = true; const count = requests.length;
    await page.reload(); await page.getByRole('checkbox', { name: 'Parse in the background' }).check(); await input.fill('JFK to LAX Sunday'); await input.press('Enter');
    await waitFor(() => requests.length > count);
    await page.getByRole('button', { name: 'Cancel parsing' }).click(); await page.getByText('Parsing cancelled.', { exact: true }).waitFor(); await settled();
    assert.equal(await input.isEnabled(), true);
    hold = false; malformed = true;
    await input.fill('JFK to LAX malformed'); await input.press('Enter'); await page.getByText(/Background parsing stopped/).waitFor();
    assert.equal(await page.getByText('private fixture response', { exact: true }).count(), 0); malformed = false;

    // A client disconnect must stop a synchronous generation at the transport boundary.
    hold = true; const beforeCancel = requests.length; const cancel = new AbortController();
    const synchronous = fetch(origin + '/api/parse', { method: 'POST', headers, signal: cancel.signal, body: JSON.stringify({ query: 'JFK to LAX cancelled sync' }) }).catch(error => error);
    await waitFor(() => requests.length > beforeCancel); cancel.abort(); await synchronous;
    await waitFor(() => pending.every(response => response.destroyed));

    // Next's real SIGTERM may exit before asynchronous settlement; restart must fence it.
    const stopped = await api('/api/parse', { query: 'JFK to LAX interrupted', mode: 'async' }); assert.equal(stopped.response.status, 202);
    await waitFor(async () => (await privateStatus(stopped.data.data.id)).data.data.status === 'running');
    await stop(web);
    await pool.query('UPDATE "ParseReservation" SET "leaseUntil"=now()-interval \'1 second\' WHERE "jobId"=$1 AND "settledAt" IS NULL', [stopped.data.data.id]);
    await pool.query('UPDATE "ParseJob" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1 AND status=\'running\'', [stopped.data.data.id]);
    hold = false; await startWeb();
    const interrupted = await privateStatus(stopped.data.data.id); assert.equal(interrupted.data.data.status, 'failed'); assert.equal(interrupted.data.data.result, undefined);
    const recovery = await api('/api/admin/parse'); assert.equal(recovery.response.status, 200);
    for (const reservation of recovery.data.data.reservations) {
      assert.equal((await api('/api/admin/parse', { ...reservation, actorScope: recovery.data.data.actorScope, localWorkersStopped: true })).response.status, 400);
      assert.equal((await api('/api/admin/parse', { id: reservation.id, generation: reservation.generation + 1, actorScope: recovery.data.data.actorScope, localWorkersStopped: true })).response.status, 412);
      assert.equal((await api('/api/admin/parse', { id: reservation.id, generation: reservation.generation, actorScope: recovery.data.data.actorScope, localWorkersStopped: true })).response.status, 200);
    }
    assert.equal((await privateStatus(stopped.data.data.id)).data.data.status, 'failed');
    await page.goto(origin + '/');
    for (const locale of ['en', 'es', 'de', 'fr', 'pt']) {
      const messages = JSON.parse(await readFile(join(root, 'apps/web/messages', locale, 'components.json'), 'utf8')).SearchBar;
      await context.addCookies([{ name: 'ft-locale', value: locale, url: origin }]); await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
      await page.getByRole('checkbox', { name: messages.backgroundParse }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      if (locale === 'en') await search.screenshot({ path: join(screenshots, 'flight-parse-mobile.png') });
    }
    assert.deepEqual(errors, []);
    console.log('PASS synchronous and async production parsing, private owners/capabilities, cancellation, failure, Next termination/recovery and five mobile locales');
  }
} finally {
  await browser?.close();
  if (memberId && headers && web && web.exitCode === null && web.signalCode === null) {
    const deleted = await api('/api/admin/users/' + memberId, undefined, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  }
  await stop(web);
  for (const response of pending) response.destroy();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await pool.query('DELETE FROM "ParseJob"'); await pool.query('DELETE FROM "ParseReservation"');
  await pool.end();
}
