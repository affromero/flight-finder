import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const directory = '/app/apps/web/data/car-locations';
assert.deepEqual((await readdir('/app/apps/web/data')).sort(), ['car-locations']);
assert.deepEqual((await readdir(directory)).sort(), ['ATTRIBUTION.txt', 'catalog.json.gz', 'manifest.json']);
assert.ok((await readFile(`${directory}/ATTRIBUTION.txt`, 'utf8')).trim());
const origin = 'http://127.0.0.1:3003';
const headers = process.env.FLIGHT_FINDER_SESSION ? { Cookie: `ft-session=${process.env.FLIGHT_FINDER_SESSION}` } : {};
const archive = await fetch(`${origin}/api/cars/location-data`, { headers, signal: AbortSignal.timeout(30_000) });
assert.equal(archive.status, 200);
assert.match(archive.headers.get('content-type'), /application\/gzip/);
assert.deepEqual(Buffer.from(await archive.arrayBuffer()), await readFile(`${directory}/catalog.json.gz`));
const locations = await fetch(`${origin}/api/cars/locations?q=LHR`, { headers, signal: AbortSignal.timeout(30_000) });
if (process.env.SELF_HOSTED !== 'true') {
  assert.equal(locations.status, 404);
  console.log('PASS catalog download and disabled rental search API');
} else {
  assert.equal(locations.status, 200);
  const result = await locations.json();
  assert.equal(result.ok, true);
  assert.ok(result.data.some(place => place.iata === 'LHR' && place.country === 'GB' && place.version));
  const invalid = await fetch(`${origin}/api/cars/locations?q=${'x'.repeat(101)}`, { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(invalid.status, 400);
  const cli = JSON.parse(execFileSync('flight-finder-tui', ['cars', '--server', origin, '--json', 'locations', 'LHR'], { encoding: 'utf8', timeout: 30_000 }));
  assert.ok(cli.some(place => place.iata === 'LHR' && place.country === 'GB'));
  console.log('PASS self-hosted catalog search, rejected oversized query and bundled rental CLI');
}
