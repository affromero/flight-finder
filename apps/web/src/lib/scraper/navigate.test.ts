import { describe, it, expect } from 'vitest';
import {
  buildGoogleFlightsUrl,
  buildGoogleFlightsUrlCandidates,
  pageHasRequestedRoute,
} from './navigate';

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
    expect(candidates[1]).toContain('one+way+BDS+to+JFK+2026-11-09');
    expect(candidates[1]).not.toContain('flights+from');
    expect(candidates[2]).toContain('one+way+flights+to+JFK+from+BDS+departing+2026-11-09');
  });

  it('every one-way candidate carries the "one way" token (regression: silent trip-type drift)', () => {
    // Without an explicit "one way" marker Google may infer round trip from
    // a single date and return prices that include an unrequested return leg.
    // Every one-way candidate must carry the marker so trip type is never
    // ambiguous to Google's parser.
    const candidates = buildGoogleFlightsUrlCandidates(oneWay);
    for (const url of candidates) {
      expect(url).toContain('one+way');
    }
  });

  it('every candidate carries the requested date — never a date-less URL', () => {
    // The SEO landing /flights-from-X-to-Y.html was rejected for #65 because
    // Google fills missing dates with defaults, which would silently write
    // snapshots tagged with the user's travelDate but priced for the wrong
    // departure. Every candidate must carry the requested date.
    const candidates = buildGoogleFlightsUrlCandidates(oneWay);
    for (const url of candidates) {
      expect(url).toContain('2026-11-09');
    }
    expect(candidates.some((u) => u.includes('flights-from-BDS-to-JFK.html'))).toBe(false);
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
    expect(candidates[2]).toContain('departing+2026-11-09+returning+2026-11-15');
    // No candidate should announce one-way intent on a round trip.
    for (const url of candidates) {
      expect(url).not.toContain('one+way');
    }
  });
});

describe('IATA validation (regression: query-param injection via raw interpolation)', () => {
  // URLSearchParams encodes specials safely, but a malformed code (lowercase,
  // contains an ampersand, contains a space) means the upstream parser wrote
  // garbage; building a URL on top of garbage masks the real bug. Reject
  // explicitly at the boundary.
  const ok = {
    origin: 'BDS',
    destination: 'JFK',
    dateFrom: new Date('2026-11-09T00:00:00Z'),
    dateTo: new Date('2026-11-09T00:00:00Z'),
    tripType: 'one_way',
  };

  it.each([
    ['lowercase code', { origin: 'bds' }],
    ['contains ampersand', { origin: 'BDS&curr=USD' }],
    ['contains hash', { destination: 'JFK#x' }],
    ['contains space', { origin: 'BD S' }],
    ['too short', { origin: 'BD' }],
    ['too long', { origin: 'BDSX' }],
    ['empty', { origin: '' }],
  ])('rejects %s', (_label, override) => {
    expect(() => buildGoogleFlightsUrl({ ...ok, ...override })).toThrow(/Invalid IATA/);
    expect(() => buildGoogleFlightsUrlCandidates({ ...ok, ...override })).toThrow(/Invalid IATA/);
  });

  it('accepts standard 3-letter uppercase codes', () => {
    expect(() => buildGoogleFlightsUrlCandidates(ok)).not.toThrow();
  });
});

describe('pageHasRequestedRoute (post-navigation defense)', () => {
  // After the URL fix and rotation, this is the last line of defense against
  // silent route corruption: even if a candidate URL "succeeds", verify the
  // rendered page is showing the requested route before extracting prices.

  it('returns true when both airport codes appear in the page text', () => {
    const text = 'Flights from BDS to JFK\n€96\nTurkish Airlines\nDeparts Wed Nov 9';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('returns false when origin code is missing (homepage fallback case)', () => {
    // Bare /travel/flights homepage shows recommended destinations from your
    // location — JFK might appear in suggestions, BDS will not.
    const text = 'Top destinations from Rome (FCO): JFK New York, LHR London';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('returns false when destination code is missing (route-substitution case)', () => {
    // If Google silently swaps the destination (BDS to FCO instead of JFK),
    // we must NOT write snapshots tagged JFK with FCO prices.
    const text = 'Cheapest flights from BDS to FCO: €45';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('uses word boundaries so codes inside other tokens do not false-match', () => {
    // "PAYTON" must not satisfy a search for "AYT" — both are 3 chars but the
    // user is tracking AYT (Antalya), not a name.
    const text = 'Booking under PAYTON, John\nDeparts ISTANBUL';
    expect(pageHasRequestedRoute(text, 'IST', 'AYT')).toBe(false);
  });

  it('matches case-sensitively (IATA codes are uppercase)', () => {
    // IATA codes are always uppercase. A page containing only lowercase "bds"
    // is suspicious and should not satisfy the check.
    const text = 'flights from bds to jfk are available';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });
});
