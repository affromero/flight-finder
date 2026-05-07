import { describe, it, expect } from 'vitest';
import {
  buildGoogleFlightsUrl,
  buildGoogleFlightsUrlCandidates,
  pageHasRequestedRoute,
  pageRedirectedToHomepage,
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

describe('pageHasRequestedRoute (strict directional defense)', () => {
  // Strict patterns: each pattern requires the airport codes adjacent to a
  // route connector with no other IATA-shaped token between them.

  // ---- POSITIVE cases: real Google Flights page text shapes ----

  it('matches the page header "Flights from BDS to JFK"', () => {
    const text = 'Flights from BDS to JFK\n€96\nTurkish Airlines\nDeparts Wed Nov 9';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('matches the airport-name header "BDS Brindisi to JFK"', () => {
    // Google often renders the search bar with airport names mixed with codes.
    const text = 'BDS Brindisi to JFK John F. Kennedy';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('matches arrow connectors', () => {
    const text = 'BDS → JFK · 14h 20m · 1 stop';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('matches dash connectors with adjacent codes', () => {
    expect(pageHasRequestedRoute('BDS - JFK', 'BDS', 'JFK')).toBe(true);
    expect(pageHasRequestedRoute('BDS – JFK', 'BDS', 'JFK')).toBe(true);
    expect(pageHasRequestedRoute('BDS — JFK', 'BDS', 'JFK')).toBe(true);
    expect(pageHasRequestedRoute('BDS-JFK', 'BDS', 'JFK')).toBe(true);
  });

  // ---- NEGATIVE cases: silent-corruption modes that previously leaked ----

  it('rejects a chained route "BDS Brindisi to LHR via JFK"', () => {
    // Audit cycle 3 caught this: previous loose regex matched
    // BDS .* to .* JFK across the whole string, ignoring that the actual
    // route is BDS to LHR with JFK as a layover.
    const text = 'BDS Brindisi to LHR via JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects a multi-leg sentence "BDS to FCO and FCO to JFK"', () => {
    // Two legitimate routes back to back must not satisfy a single-route
    // tracker. The lazy match of unrelated context blocks IATA codes from
    // appearing between origin and destination.
    const text = 'BDS to FCO and FCO to JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects a flight card with no header connector ("BDS 6:35 PM ... JFK 9:55 PM")', () => {
    // A previous test of this exact text passed only because "stop" contains
    // "to" inside an unbounded regex. With strict tokenization the page text
    // must carry an explicit "to", arrow, or dash adjacent to both codes,
    // which only the page header reliably has.
    const text = 'BDS 6:35 PM Turkish Airlines TK 1882 14h 20m 1 stop in IST JFK 9:55 PM';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects when origin code is missing (homepage fallback)', () => {
    const text = 'Top destinations from Rome (FCO): JFK New York, LHR London';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects route substitution (BDS to FCO when user wanted BDS to JFK)', () => {
    const text = 'Cheapest flights from BDS to FCO: €45';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects swapped route (JFK to BDS when user wanted BDS to JFK)', () => {
    const text = 'Flights from JFK to BDS\n€350\nDelta';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects unrelated suggestion lists with codes scattered', () => {
    const text = `Recent searches:
      LHR to JFK
      MAD to FCO
      Popular from your area:
        BDS · Brindisi
        FCO · Rome
        NAP · Naples`;
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects "to" appearing inside other words ("stop", "Toronto", "destination")', () => {
    // These contain "to" as a substring but never as a tokenized word.
    const text = 'BDS sets a stop record at the destination Toronto and JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('uses word boundaries so codes inside other tokens do not false-match', () => {
    const text = 'Booking under PAYTON, John\nDeparts ISTANBUL';
    expect(pageHasRequestedRoute(text, 'IST', 'AYT')).toBe(false);
  });

  it('matches case-sensitively (IATA codes are uppercase)', () => {
    const text = 'flights from bds to jfk are available';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('rejects dashes inside dates and durations from connecting unrelated codes', () => {
    // A time range "BDS 6:35 - 9:55 JFK" has a dash but it connects times
    // not codes. The dash pattern requires immediate adjacency to both codes.
    const text = 'BDS 6:35 - 9:55 JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  // ---- Allowlist exceptions: origin/destination aliases and currency codes ----

  it('accepts repeated origin code as parenthetical alias ("BDS Brindisi (BDS) to JFK")', () => {
    // Google Flights commonly renders headers with the code, the airport name,
    // and the code again in parentheses. The repeated origin must not block
    // the gap.
    const text = 'BDS Brindisi (BDS) to JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('accepts repeated destination code in parens ("from BDS to JFK (JFK)")', () => {
    const text = 'Flights from BDS to JFK (JFK) New York';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('accepts currency codes in the gap ("BDS to USD airport JFK")', () => {
    // USD/EUR/GBP/JPY/CHF/CAD/AUD/TRY are 3-letter uppercase but not airport
    // codes. Google may render currency labels in flight pages.
    const text = 'BDS Brindisi to USD area JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('accepts TRY in the gap (Turkish Lira, regression for #64 IST/AYT scenario)', () => {
    // The IST/AYT example in issue #64 is in the Turkish market where TRY
    // labels commonly appear in Google Flights headers. Without TRY in the
    // allowlist the route validator would always reject those pages.
    const text = 'IST Istanbul to TRY area AYT';
    expect(pageHasRequestedRoute(text, 'IST', 'AYT')).toBe(true);
  });

  it('still rejects unknown 3-letter uppercase codes (real airport layovers)', () => {
    // Allowlist must NOT swallow real airport codes that are layovers.
    expect(pageHasRequestedRoute('BDS to LHR via JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS via NYC to JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS Brindisi to FCO via JFK', 'BDS', 'JFK')).toBe(false);
  });
});

describe('pageRedirectedToHomepage (the #65 headline failure mode)', () => {
  it('detects when Google strips the q= parameter on redirect', () => {
    const input = 'https://www.google.com/travel/flights?q=one+way+BDS+to+JFK&hl=en';
    const final = 'https://www.google.com/travel/flights?hl=en';
    expect(pageRedirectedToHomepage(input, final)).toBe(true);
  });

  it('returns false when q= survives the redirect', () => {
    const input = 'https://www.google.com/travel/flights?q=one+way+BDS+to+JFK&hl=en';
    const final = 'https://www.google.com/travel/flights?q=one+way+BDS+to+JFK&hl=en';
    expect(pageRedirectedToHomepage(input, final)).toBe(false);
  });

  it('returns false when input never had a q= (cannot be a fallback)', () => {
    // We are not currently producing such URLs (every candidate has q=),
    // but defending against the symmetric case keeps the helper honest.
    const input = 'https://www.google.com/travel/flights/search?tfs=ABC';
    const final = 'https://www.google.com/travel/flights?hl=en';
    expect(pageRedirectedToHomepage(input, final)).toBe(false);
  });

  it('returns false on malformed URL inputs (defensive)', () => {
    expect(pageRedirectedToHomepage('not a url', 'also not a url')).toBe(false);
  });
});
