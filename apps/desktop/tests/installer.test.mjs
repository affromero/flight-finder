import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const publicDir = fileURLToPath(new URL('../../web/public/', import.meta.url));
const windows = process.platform === 'win32';
const gitRoot = windows ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [join(base, 'Git'), join(base, 'Programs/Git')])
  .find(dir => existsSync(join(dir, 'bin/bash.exe'))) : null;
for (const binding of ['', '127.0.0.1']) {
  test(`installer preserves its selected port and ${binding ? 'explicit localhost' : 'default network'} binding`, () => {
    if (windows) assert.ok(gitRoot, 'Windows installer tests require Git for Windows with Git Bash');
    const home = mkdtempSync(join(tmpdir(), 'flight finder desktop install '));
    try {
      const bin = join(home, 'bin'); mkdirSync(bin);
      for (const [name, body] of Object.entries({ docker: 'exit 0', curl: 'exit 1', lsof: '[ "$2" = :3003 ]', uname: `echo ${windows ? 'MINGW64_NT-10.0' : 'Darwin'}` })) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      }
      const shellPath = windows ? [bin, join(gitRoot, 'usr/bin'), join(gitRoot, 'mingw64/bin'), process.env.PATH].join(delimiter)
        : `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
      const result = spawnSync(windows ? join(gitRoot, 'bin/bash.exe') : 'bash', [join(publicDir, 'install.sh').replaceAll('\\', '/')], { encoding: 'utf8', timeout: 15_000,
        env: { ...(windows ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, WINDIR: process.env.WINDIR, TEMP: home, TMP: home } : {}),
          PATH: shellPath, HOME: home.replaceAll('\\', '/'), USER: 'desktop-fixture', SHELL: '/bin/bash',
          FLIGHT_FINDER_YES: '1', FLIGHT_FINDER_OPEN_BROWSER: '0', FLIGHT_FINDER_SKIP_BUILD: '1', FLIGHT_FINDER_SKIP_START: '1',
          FLIGHT_FINDER_DIR: '', HOST_PORT: '3003', PORT: '',
          FLIGHT_FINDER_CLI_SOURCE: join(publicDir, 'flight-finder-cli').replaceAll('\\', '/'), FLIGHT_FINDER_BIND_ADDRESS: binding } });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const config = readFileSync(join(home, '.flight-finder/.env'), 'utf8');
      assert.match(config, /^HOST_PORT=3004$/m);
      if (binding) assert.match(config, /^HOST_BIND_ADDRESS=127\.0\.0\.1$/m);
      else assert.doesNotMatch(config, /^HOST_BIND_ADDRESS=/m);
      assert.match(readFileSync(join(home, '.flight-finder/docker-compose.yml'), 'utf8'), /\$\{HOST_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{HOST_PORT:-3003\}:3003/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
