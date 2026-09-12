import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveBaseUrl } from './run';

describe('resolveBaseUrl', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.SELF_HOSTED;
  });
  afterEach(() => {
    process.env = { ...prev };
  });

  it('prefers the admin-configured publicBaseUrl', () => {
    expect(resolveBaseUrl('https://mine.example/')).toBe('https://mine.example');
  });

  it('falls back to APP_URL when publicBaseUrl is null', () => {
    process.env.APP_URL = 'https://env.example';
    expect(resolveBaseUrl(null)).toBe('https://env.example');
  });

  it('returns null on a self-hosted instance with nothing configured (no wrong link)', () => {
    process.env.SELF_HOSTED = 'true';
    expect(resolveBaseUrl(null)).toBeNull();
  });

  it('falls back to the hosted site only when not self-hosted', () => {
    expect(resolveBaseUrl(null)).toBe('https://flight-finder.org');
  });
});
