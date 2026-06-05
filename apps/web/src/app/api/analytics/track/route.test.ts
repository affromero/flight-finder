import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

interface TrackParams {
  path: string;
  ip: string;
  userAgent: string;
  referrer?: string;
  botScore?: number;
}

const tracked: TrackParams[] = [];

// trackPageViewAsync is the DB/filesystem boundary; mock it and capture inputs.
vi.mock('@/lib/analytics/track', () => ({
  trackPageViewAsync: (params: TrackParams) => {
    tracked.push(params);
  },
}));

import { POST } from './route';

const SECRET = 'test-admin-session-secret';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function makeRequest(body: unknown, opts: { token?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = 'token' in opts ? opts.token : SECRET;
  if (token != null) headers['x-internal-token'] = token;
  return new NextRequest('http://localhost/api/analytics/track', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

function lastTracked(): TrackParams {
  const entry = tracked[tracked.length - 1];
  if (!entry) throw new Error('expected trackPageViewAsync to have been called');
  return entry;
}

describe('POST /api/analytics/track', () => {
  beforeEach(() => {
    tracked.length = 0;
    process.env.ADMIN_SESSION_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.ADMIN_SESSION_SECRET;
  });

  it('rejects a public caller with no internal token (403) and records nothing', async () => {
    const res = await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA, ip: '1.2.3.4' }, { token: null }));
    expect(res.status).toBe(403);
    expect(tracked).toHaveLength(0);
  });

  it('rejects a wrong internal token (403)', async () => {
    const res = await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA }, { token: 'wrong-secret' }));
    expect(res.status).toBe(403);
    expect(tracked).toHaveLength(0);
  });

  it('rejects all calls when ADMIN_SESSION_SECRET is unset', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const res = await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA }, { token: '' }));
    expect(res.status).toBe(403);
    expect(tracked).toHaveLength(0);
  });

  it('rejects missing required fields with 400 for an internal caller', async () => {
    const res = await POST(makeRequest({ userAgent: CHROME_UA }));
    expect(res.status).toBe(400);
    expect(tracked).toHaveLength(0);
  });

  it('trusts the middleware-supplied ip for an internal caller', async () => {
    const res = await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA, ip: '203.0.113.50' }));
    expect(res.status).toBe(200);
    expect(lastTracked().ip).toBe('203.0.113.50');
  });

  it('caps over-long path, userAgent, and referrer fields', async () => {
    const longPath = '/' + 'a'.repeat(5000);
    const longUa = 'b'.repeat(5000);
    const longRef = 'http://x/' + 'c'.repeat(5000);
    await POST(makeRequest({ path: longPath, userAgent: longUa, referrer: longRef, ip: '1.1.1.1' }));
    expect(lastTracked().path.length).toBe(2048);
    expect(lastTracked().userAgent.length).toBe(512);
    expect(lastTracked().referrer?.length).toBe(2048);
  });

  it('forces score 3 for a known bot UA even when the body claims human', async () => {
    await POST(makeRequest({ path: '/q/1', userAgent: 'GPTBot/1.0', botScore: 1, ip: '1.1.1.1' }));
    expect(lastTracked().botScore).toBe(3);
  });

  it('clamps an out-of-range body botScore for a human UA', async () => {
    await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA, botScore: 99, ip: '1.1.1.1' }));
    expect(lastTracked().botScore).toBe(3);
  });

  it('floors a sub-range body botScore for a human UA', async () => {
    await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA, botScore: -5, ip: '1.1.1.1' }));
    expect(lastTracked().botScore).toBe(1);
  });

  it('honors a valid header-derived hint for a human UA', async () => {
    await POST(makeRequest({ path: '/q/1', userAgent: CHROME_UA, botScore: 2, ip: '1.1.1.1' }));
    expect(lastTracked().botScore).toBe(2);
  });
});
