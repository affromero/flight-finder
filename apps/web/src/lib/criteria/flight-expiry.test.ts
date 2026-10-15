import { describe, expect, it } from 'vitest';
import { flightExpiry, hasFlightExpired, trackerExpiry, flightRefreshTarget } from './flight-expiry';

describe('flight tracking through the outbound UTC day', () => {
  it.each(['2027-05-01T00:00:00Z', '2027-05-20T00:00:00Z'])(
    'uses departure instead of the legacy stored expiry %s', storedExpiry => {
      const query = { dateFrom: new Date('2027-05-01T00:00:00Z'), expiresAt: new Date(storedExpiry) };
      expect(trackerExpiry(query).toISOString()).toBe('2027-05-02T00:00:00.000Z');
      expect(hasFlightExpired(query, new Date('2027-05-01T23:59:59.999Z'))).toBe(false);
      expect(hasFlightExpired(query, new Date('2027-05-02T00:00:00Z'))).toBe(true);
      expect(query.expiresAt.toISOString()).toBe(new Date(storedExpiry).toISOString());
    },
  );

  it.each([
    ['2028-02-29T00:00:00Z', '2028-03-01T00:00:00.000Z'],
    ['2027-12-31T00:00:00Z', '2028-01-01T00:00:00.000Z'],
    ['2027-03-28T00:30:00+02:00', '2027-03-28T00:00:00.000Z'],
  ])('expires the UTC outbound day %s at %s', (departure, expected) => {
    expect(flightExpiry(new Date(departure)).toISOString()).toBe(expected);
  });

  it('keeps rolling seed routes live after their stored departure', () => {
    const seed = { dateFrom: new Date('2000-01-01'), expiresAt: new Date('2099-12-31'), isSeed: true };
    expect(hasFlightExpired(seed, new Date('2027-05-02'))).toBe(false);
    expect(trackerExpiry(seed)).toEqual(seed.expiresAt);
  });

  it('refreshes a live sibling while skipping expired, paused and seed trackers', () => {
    const queries = [
      { id: 'expired', dateFrom: new Date('2027-04-30'), active: true },
      { id: 'paused', dateFrom: '2027-05-02', active: false },
      { id: 'seed', dateFrom: '2027-05-02', active: true, isSeed: true },
      { id: 'live', dateFrom: '2027-05-02', active: true },
    ];
    const now = new Date('2027-05-01T12:00:00Z');
    expect(flightRefreshTarget(queries, now)).toBe('live');
    expect(flightRefreshTarget(queries.slice(0, 3), now)).toBeNull();
  });
});
