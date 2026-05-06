import { describe, it, expect } from 'vitest';
import { buildGoogleFlightsUrl, buildGoogleFlightsUrlCandidates } from './navigate';

describe('buildGoogleFlightsUrl', () => {
  const base = {
    origin: 'JFK',
    destination: 'LAX',
    dateFrom: new Date('2026-06-15T00:00:00Z'),
    dateTo: new Date('2026-06-22T00:00:00Z'),
  };

  it('includes &curr= when currency is set', () => {
    const url = buildGoogleFlightsUrl({ ...base, currency: 'EUR' });
    expect(url).toContain('&curr=EUR');
  });

  it('omits &curr= when currency is null', () => {
    const url = buildGoogleFlightsUrl({ ...base, currency: null });
    expect(url).not.toContain('&curr=');
  });

  it('omits &curr= when currency is undefined', () => {
    const url = buildGoogleFlightsUrl({ ...base });
    expect(url).not.toContain('&curr=');
  });

  it('includes &gl= when country is set', () => {
    const url = buildGoogleFlightsUrl({ ...base, country: 'DE' });
    expect(url).toContain('&gl=DE');
  });

  it('includes both &curr= and &gl= when both are set', () => {
    const url = buildGoogleFlightsUrl({ ...base, currency: 'EUR', country: 'DE' });
    expect(url).toContain('&curr=EUR');
    expect(url).toContain('&gl=DE');
  });

  it('omits both &curr= and &gl= when both are null', () => {
    const url = buildGoogleFlightsUrl({ ...base, currency: null, country: null });
    expect(url).not.toContain('&curr=');
    expect(url).not.toContain('&gl=');
    expect(url).toContain('&hl=en');
  });

  describe('one-way URL formatting (regression: #65)', () => {
    const baseOneWay = {
      origin: 'BDS',
      destination: 'JFK',
      dateFrom: new Date('2026-11-09T00:00:00Z'),
      dateTo: new Date('2026-11-09T00:00:00Z'),
      tripType: 'one_way',
    };

    it('omits the redundant "+to+${dateTo}" segment for one-way', () => {
      // Google's NLU misparses "on YYYY-MM-DD to YYYY-MM-DD" for less common
      // airport codes and falls back to the homepage. One-way searches must
      // only emit a single date.
      const url = buildGoogleFlightsUrl(baseOneWay);
      expect(url).toContain('one+way+flights+from+BDS+to+JFK+on+2026-11-09');
      expect(url).not.toMatch(/on\+2026-11-09\+to\+2026-11-09/);
    });

    it('keeps "+to+${dateTo}" for round-trip searches with same dates', () => {
      const url = buildGoogleFlightsUrl({ ...baseOneWay, tripType: 'round_trip' });
      expect(url).toContain('flights+from+BDS+to+JFK+on+2026-11-09+to+2026-11-09');
      expect(url).not.toContain('one+way');
    });
  });
});

describe('buildGoogleFlightsUrlCandidates (regression: #65)', () => {
  const oneWay = {
    origin: 'BDS',
    destination: 'JFK',
    dateFrom: new Date('2026-11-09T00:00:00Z'),
    dateTo: new Date('2026-11-09T00:00:00Z'),
    tripType: 'one_way',
    currency: 'EUR',
  };

  it('returns three structurally distinct URL formats', () => {
    const candidates = buildGoogleFlightsUrlCandidates(oneWay);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toContain('one+way+flights+from+BDS+to+JFK');
    expect(candidates[1]).toMatch(/\?q=BDS\+to\+JFK\+2026-11-09/);
    expect(candidates[1]).not.toContain('flights+from');
    expect(candidates[2]).toContain('/flights-from-BDS-to-JFK.html');
  });

  it('propagates currency and locale to every candidate', () => {
    const candidates = buildGoogleFlightsUrlCandidates({ ...oneWay, country: 'IT' });
    for (const url of candidates) {
      expect(url).toContain('hl=en');
      expect(url).toContain('curr=EUR');
      expect(url).toContain('gl=IT');
    }
  });

  it('all candidates differ — retrying must hit a new URL each time', () => {
    const candidates = buildGoogleFlightsUrlCandidates(oneWay);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('handles round-trip dates correctly across candidates', () => {
    const rt = {
      ...oneWay,
      tripType: 'round_trip',
      dateTo: new Date('2026-11-15T00:00:00Z'),
    };
    const candidates = buildGoogleFlightsUrlCandidates(rt);
    expect(candidates[0]).toContain('on+2026-11-09+to+2026-11-15');
    expect(candidates[1]).toContain('BDS+to+JFK+2026-11-09+to+2026-11-15');
    // Path landing has no date; the form is filled after navigation.
    expect(candidates[2]).not.toContain('2026-11-09');
  });
});
