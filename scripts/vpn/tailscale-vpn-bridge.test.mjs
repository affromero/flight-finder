import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initial, executable } from './tailscale-fixture.mjs';

let directory, bridge, base;
const proxyUrl = 'socks5://tailscale:1055';

async function fixture(value) { await writeFile(join(directory, 'fixture.json'), JSON.stringify({ status: initial(), ...value })); }
async function requests() {
  try { return (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const mutations = async () => (await requests()).filter(request => request.command === 'tailscale' && request.args[1] === 'set');
async function request(path, method = 'GET', signal = AbortSignal.timeout(5000)) { return fetch(base + path, { method, signal }); }
async function waitFor(work) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await work()) return; await pause(20); }
  throw Error('Fixture condition did not settle');
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flight-mullvad-'));
  for (const name of ['tailscale', 'curl']) await writeFile(join(directory, name), '#!' + process.execPath + '\n' + executable, { mode: 0o700 });
  await fixture({});
  bridge = spawn(process.execPath, [fileURLToPath(new URL('./tailscale-vpn-bridge.mjs', import.meta.url))], {
    env: { ...process.env, PATH: directory + ':' + process.env.PATH, VPN_FIXTURE_DIRECTORY: directory, VPN_BRIDGE_PORT: '0', TAILSCALE_VPN_SOCKS_URL: proxyUrl,
      TAILSCALE_SOCKET: join(directory, 'dedicated-daemon.sock') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Bridge startup timed out: ' + output)), 5000);
    bridge.stderr.on('data', chunk => { output += chunk; });
    bridge.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on port (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    });
    bridge.once('exit', code => { clearTimeout(timer); reject(Error('Bridge exited ' + code + ': ' + output)); });
    bridge.once('error', error => { clearTimeout(timer); reject(error); });
  });
});

afterEach(async () => {
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
    const exited = once(bridge, 'exit'); bridge.kill('SIGTERM'); await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('readiness and available countries bind to the dedicated proxy without changing the daemon', async () => {
  assert.deepEqual(await (await request('/v1/status')).json(), { connected: false, currentLocation: null, currentCountry: null, proxyUrl });
  assert.deepEqual(await (await request('/v1/locations')).json(), { locations: ['DE: Mullvad', 'US: Mullvad'], proxyUrl });
  assert.deepEqual(await mutations(), []);
  assert.ok((await requests()).every(value => value.args[0] === '--socket=' + join(directory, 'dedicated-daemon.sock')));
});

test('switching verifies selected identity and probes remote DNS through the browser proxy', async () => {
  const response = await request('/v1/connect/US', 'POST');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, connected: true, currentLocation: 'us-node.mullvad.ts.net.', currentCountry: 'US', proxyUrl, exitIp: '8.8.8.8' });
  const observed = await requests();
  assert.equal(observed.find(value => value.command === 'curl').args.join(' '), '--silent --show-error --fail --max-time 12 --noproxy  --proxy socks5h://tailscale:1055 https://am.i.mullvad.net/json');
  assert.deepEqual((await mutations()).map(value => value.args[2]), ['--exit-node=100.64.0.1']);
});

test('disconnect clears only the dedicated exit selection and preserves tailnet enrollment', async () => {
  await request('/v1/connect/DE', 'POST');
  const response = await request('/v1/disconnect', 'POST');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, connected: false, currentLocation: null, currentCountry: null, proxyUrl });
  assert.deepEqual((await mutations()).map(value => value.args[2]), ['--exit-node=100.64.0.2', '--exit-node=']);
  assert.ok((await requests()).every(value => !value.args.some(arg => ['down', 'logout', 'up'].includes(arg))));
});

test('malformed status returns a redacted error without changing the network', async () => {
  await fixture({ malformed: true });
  const response = await request('/v1/status');
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private daemon output/);
  assert.deepEqual(await mutations(), []);
});

test('kernel networking fails closed', async () => {
  const status = initial(); status.TUN = true;
  await fixture({ status });
  assert.equal((await request('/v1/connect/US', 'POST')).status, 502);
  assert.deepEqual(await mutations(), []);
});

test('unavailable, expired and unrelated peers never become selectable exit nodes', async () => {
  const status = initial(); status.Peer.us.Expired = true; status.Peer.de.DNSName = 'unrelated.example';
  await fixture({ status });
  assert.deepEqual((await (await request('/v1/locations')).json()).locations, []);
  assert.equal((await request('/v1/connect/US', 'POST')).status, 502);
  assert.deepEqual(await mutations(), []);
  assert.equal((await request('/v1/status')).status, 200);
});

test('duplicate peer identities cannot authorize switching', async () => {
  const status = initial(); status.Peer.de.ID = status.Peer.us.ID;
  await fixture({ status });
  assert.equal((await request('/v1/connect/US', 'POST')).status, 502);
  assert.deepEqual(await mutations(), []);
});

test('a conflicting selected peer fails closed', async () => {
  const status = initial(); status.ExitNodeStatus = { ID: status.Peer.us.ID, Online: true }; status.Peer.us.ExitNode = true; status.Peer.de.ExitNode = true;
  await fixture({ status });
  assert.equal((await request('/v1/status')).status, 502);
  assert.equal((await request('/v1/connect/US', 'POST')).status, 502);
  assert.equal((await request('/v1/disconnect', 'POST')).status, 502);
  assert.deepEqual(await mutations(), []);
});

test('an unverified probe quarantines subsequent operations until operator recovery', async () => {
  await fixture({ probe: { mullvad_exit_ip: false, ip: '8.8.8.8' } });
  assert.equal((await request('/v1/connect/US', 'POST')).status, 502);
  assert.equal((await request('/v1/status')).status, 503);
  assert.equal((await request('/v1/disconnect', 'POST')).status, 503);
  assert.equal((await mutations()).length, 1);
});

test('cancelling a real in-flight command kills it and leaves the bridge quarantined', async () => {
  await fixture({ hold: true });
  const controller = new AbortController();
  const pending = request('/v1/connect/US', 'POST', controller.signal);
  const rejected = assert.rejects(pending, /abort/i);
  let pid;
  await waitFor(async () => { try { pid = Number(await readFile(join(directory, 'mutation.pid'), 'utf8')); return true; } catch { return false; } });
  assert.equal((await request('/v1/connect/DE', 'POST')).status, 409);
  controller.abort(); await rejected;
  await waitFor(async () => (await request('/v1/status')).status === 503);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
  assert.equal((await mutations()).length, 1);
});

test('browser origins and unexpected methods cannot mutate the network', async () => {
  assert.equal((await fetch(base + '/v1/connect/US', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request('/v1/connect/US')).status, 404);
  assert.equal((await request('/v1/logout', 'POST')).status, 404);
  assert.deepEqual(await mutations(), []);
});
