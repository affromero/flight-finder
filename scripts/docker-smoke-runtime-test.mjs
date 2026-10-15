import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = new URL('./docker-smoke-test.sh', import.meta.url);
for (const scenario of ['success', 'build-failure', 'startup-failure', 'daemon-failure', 'setup-failure', 'configuration-failure', 'endpoint-failure', 'reuse-image', 'cleanup-failure']) {
  test(`isolates smoke resources and preserves the result on ${scenario}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-smoke-behavior-'));
    try {
      const bin = join(directory, 'bin'), scripts = join(directory, 'scripts'), record = join(directory, 'calls.jsonl');
      mkdirSync(bin); mkdirSync(scripts);
      mkdirSync(join(scripts, 'testing'));
      copyFileSync(source, join(scripts, 'docker-smoke-test.sh'));
      copyFileSync(new URL('./container-car-smoke.mjs', import.meta.url), join(scripts, 'container-car-smoke.mjs'));
      copyFileSync(new URL('./testing/access-setup.py', import.meta.url), join(scripts, 'testing/access-setup.py'));
      const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), mode = process.env.SCENARIO;
fs.appendFileSync(process.env.RECORD, JSON.stringify({ args, password: process.env.POSTGRES_PASSWORD, envFiles: process.env.COMPOSE_ENV_FILES }) + '\\n');
if (args[0] === 'info') process.exit(mode === 'daemon-failure' ? 19 : 0);
if (args.includes('build') && mode === 'build-failure') process.exit(23);
if (args.includes('up') && mode === 'startup-failure') process.exit(27);
if (args.includes('down') && mode.endsWith('-failure')) process.exit(31);
if (args.includes('access') && args.includes('setup')) {
  if (mode === 'setup-failure') process.exit(43);
  let answers = 0;
  process.stdout.write('First Admin profile name: ');
  process.stdin.on('data', () => {
    answers++;
    if (answers === 1) process.stdout.write('Shared password: ');
    else if (answers === 2) process.stdout.write('Confirm shared password: ');
    else process.exit(0);
  });
}
if (args.includes('/smoke/testing/configure-smoke-provider.mjs')) {
  if (mode === 'configuration-failure') process.exit(47);
  process.stdout.write('disposable-smoke-session');
}
`;
      const curl = `#!/usr/bin/env node
if (process.argv.some(arg => arg.endsWith('/api/test/scrape'))) {
  if (!process.argv.includes('Cookie: ft-session=disposable-smoke-session')) {
    process.stdout.write(JSON.stringify({ok:false,error:'Locked'}) + '\\n401\\n');
    process.exit(22);
  }
  if (process.env.SCENARIO === 'endpoint-failure') {
    if (process.argv.includes('--fail-with-body')) process.stdout.write(JSON.stringify({ok:false,error:'Missing saved credential for Anthropic'}) + '\\n500\\n');
    process.exit(22);
  }
  process.stdout.write(JSON.stringify({ok:true,data:{checks:[],totalMs:1}}) + '\\n200\\n');
}
`;
      for (const [name, body] of [['docker', docker], ['curl', curl]]) {
        writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755);
      }
      const result = spawnSync('bash', [join(scripts, 'docker-smoke-test.sh'), ...(scenario === 'reuse-image' ? ['--no-build'] : [])], {
        encoding: 'utf8', timeout: 15_000,
        env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: directory, RECORD: record, SCENARIO: scenario,
          COMPOSE_PROJECT_NAME: 'existing-production', COMPOSE_FILE: '/never-read-compose.yml', COMPOSE_ENV_FILES: '/never-read-secrets', POSTGRES_PASSWORD: 'not-the-test-password' },
      });
      const expected = { success: 0, 'build-failure': 23, 'startup-failure': 27, 'daemon-failure': 1, 'setup-failure': 1, 'configuration-failure': 47, 'endpoint-failure': 1, 'reuse-image': 0, 'cleanup-failure': 1 }[scenario];
      assert.equal(result.status, expected, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      if (scenario === 'setup-failure') assert.match(result.stderr, /Local access setup failed/);
      if (scenario === 'endpoint-failure') assert.match(result.stdout, /Missing saved credential for Anthropic/);
      const calls = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const lifecycle = calls.filter(call => call.args[0] === 'compose');
      if (scenario === 'daemon-failure') assert.deepEqual(lifecycle, []);
      else {
        const projects = new Set(lifecycle.map(call => call.args[call.args.indexOf('-p') + 1]));
        assert.equal(projects.size, 1); assert.match([...projects][0], /^ff-smoke-[a-z0-9]+$/);
        for (const call of lifecycle) {
          assert.equal(call.args[call.args.indexOf('--env-file') + 1], '/dev/null');
          assert.equal(call.envFiles, '/dev/null'); assert.equal(call.password, 'smoketest');
          assert.ok(call.args.includes('docker-compose.test.yml'));
        }
        assert.ok(lifecycle.at(-1).args.includes('down'));
        assert.equal(lifecycle.some(call => call.args.includes('build')), scenario !== 'reuse-image');
      }
      assert.deepEqual(readdirSync(directory).sort(), ['bin', 'calls.jsonl', 'scripts']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
