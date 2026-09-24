import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function command(executable, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${executable} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

export async function setupBrowserOwner({ origin, name, password }) {
  await command('python3', ['scripts/testing/access-setup.py', 'npm', 'run', 'cli', '--', 'access', 'setup'], {
    TEST_ACCESS_NAME: name, TEST_ACCESS_PASSWORD: password,
  });
  const token = await admitBrowserHousehold({ origin, password });
  const selected = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` },
    body: JSON.stringify({ username: name }),
  });
  assert.equal(selected.status, 200, await selected.text());
  return token;
}

export async function admitBrowserHousehold({ origin, password }) {
  const response = await fetch(`${origin}/api/access/household`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('ft-session='));
  assert.ok(cookie, 'Household entry did not issue a browser session');
  return cookie.slice('ft-session='.length).split(';', 1)[0];
}

export async function addBrowserSession(context, origin, token) {
  await context.addCookies([{ name: 'ft-session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
