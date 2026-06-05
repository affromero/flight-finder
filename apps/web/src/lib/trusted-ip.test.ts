import { describe, it, expect, afterEach } from 'vitest';
import { getClientIp } from './trusted-ip';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('http://localhost/', { headers });
}

const ORIGINAL = process.env.TRUSTED_FORWARDED_FOR;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.TRUSTED_FORWARDED_FOR;
  } else {
    process.env.TRUSTED_FORWARDED_FOR = ORIGINAL;
  }
});

describe('getClientIp (trusted proxy, default)', () => {
  it('reads the first x-forwarded-for hop', () => {
    delete process.env.TRUSTED_FORWARDED_FOR;
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    delete process.env.TRUSTED_FORWARDED_FOR;
    const req = makeRequest({ 'x-real-ip': '198.51.100.4' });
    expect(getClientIp(req)).toBe('198.51.100.4');
  });

  it('treats TRUSTED_FORWARDED_FOR=true the same as default', () => {
    process.env.TRUSTED_FORWARDED_FOR = 'true';
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.9' });
    expect(getClientIp(req)).toBe('203.0.113.9');
  });

  it('uses a loopback fallback when no forwarding headers exist', () => {
    delete process.env.TRUSTED_FORWARDED_FOR;
    expect(getClientIp(makeRequest({}))).toBe('127.0.0.1');
  });
});

describe('getClientIp (no trusted proxy)', () => {
  it('ignores x-forwarded-for and collapses to a single bucket', () => {
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    const a = getClientIp(makeRequest({ 'x-forwarded-for': '1.1.1.1' }));
    const b = getClientIp(makeRequest({ 'x-forwarded-for': '2.2.2.2' }));
    const c = getClientIp(makeRequest({ 'x-real-ip': '3.3.3.3' }));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not return any attacker-supplied IP value', () => {
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    const spoofed = getClientIp(makeRequest({ 'x-forwarded-for': '9.9.9.9' }));
    expect(spoofed).not.toBe('9.9.9.9');
  });
});
