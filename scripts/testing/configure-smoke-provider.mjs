import assert from 'node:assert/strict';
import { admitBrowserHousehold } from '../access-browser-test.mjs';

const origin = 'http://127.0.0.1:3003';
const deadline = setTimeout(() => {
  console.error('Smoke provider configuration timed out');
  process.exit(1);
}, 30_000);

try {
  assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD);
  const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
  const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
  async function request(path, method = 'GET', body) {
    const response = await fetch(origin + path, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.ok, true, JSON.stringify(data));
    return data.data;
  }
  await request('/api/auth/login', 'POST', { username: process.env.TEST_ACCESS_NAME });
  const config = await request('/api/admin/config');
  await request('/api/admin/config', 'PATCH', {
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
    credentials: { compatibleApiKey: 'test-smoke-key', baseUrl: 'http://llmock:19876' },
    expectedRevision: config.providerRevision, expectedUpdatedAt: config.updatedAt,
  });
  process.stdout.write(token);
} finally {
  clearTimeout(deadline);
}
