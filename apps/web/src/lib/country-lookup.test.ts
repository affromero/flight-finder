import { describe, expect, it } from 'vitest';
import { lookupCountry } from './country-lookup';

describe('country lookup', () => {
  it('resolves public IPv4 and IPv6 addresses from the bundled database', () => {
    expect(lookupCountry('8.8.8.8')).toBe('US');
    expect(lookupCountry('2001:4860:4860::8888')).toBe('US');
  });

  it('rejects malformed addresses before reading the database', () => {
    expect(lookupCountry('not-an-address')).toBeNull();
  });
});
