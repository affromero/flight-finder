import { describe, it, expect } from 'vitest';
import {
  buildGoogleFlightsUrl,
  buildGoogleFlightsUrlCandidates,
  buildSkyscannerUrl,
  buildKayakUrl,
  hasFlightPriceSignal,
  isAggregatorSource,
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

  it.each([
    'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SGD', 'HKD',
    'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP', 'ARS',
  ])('accepts every settings-supported currency in the gap (%s)', (curr) => {
    // The settings dropdown lets users pick any of these currencies.
    // pageHasRequestedRoute must allow each one in the gap so the locales
    // we explicitly support never produce silent rejection.
    const text = `BDS Brindisi to ${curr} fares JFK`;
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(true);
  });

  it('accepts a dynamically supplied custom currency code', () => {
    // Settings exposes "Other..." which lets the user type any 3-letter ISO
    // 4217 code. Those are not in the static list but must still be allowed.
    // ZAR (South African Rand) is a real ISO code not in the dropdown.
    const text = 'BDS Brindisi to ZAR fares JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false); // not in static list
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK', 'ZAR')).toBe(true); // dynamic param allows it
  });

  it('ignores a malformed dynamic currency (not 3 uppercase)', () => {
    // Defensive: callers passing junk like 'eur', 'EU', '$$$' must not
    // expand the allowlist with arbitrary tokens.
    const text = 'BDS Brindisi to LHR fares JFK';
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK', 'lhr')).toBe(false);
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK', 'LH')).toBe(false);
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK', '$$$')).toBe(false);
  });

  it('rejects chained routes even when the layover code is allowlisted (currency/IATA overlap)', () => {
    // Several allowlisted currency codes are ALSO real (small) IATA airport
    // codes: HKD = Hakodate, BRL = Borba, CAD = Cadillac, CHF = Chefornak.
    // A naive allowlist would let "BDS to HKD via JFK" pass because HKD
    // is allowed as a currency. The fix is structural: we block the
    // chaining keywords (`via`, `layover`, `through`, `connecting`) inside
    // the gap. Real Google Flights route headers never carry those words
    // between the airport pair, so legitimate pages are unaffected, while
    // any chained phrase fails immediately at `via`.
    expect(pageHasRequestedRoute('BDS to HKD via JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS to BRL via JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS to CAD via JFK', 'BDS', 'JFK')).toBe(false);
  });

  it('rejects chained routes phrased with "layover", "through", "connecting", "stopover"', () => {
    expect(pageHasRequestedRoute('BDS to HKD layover JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS to FCO through JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS to LHR connecting JFK', 'BDS', 'JFK')).toBe(false);
    expect(pageHasRequestedRoute('BDS to HKD stopover JFK', 'BDS', 'JFK')).toBe(false);
  });

  it.each([
    ['Via', 'BDS to HKD Via JFK'],
    ['VIA', 'BDS to HKD VIA JFK'],
    ['Layover', 'BDS to HKD Layover JFK'],
    ['LAYOVER', 'BDS to HKD LAYOVER JFK'],
    ['Connecting', 'BDS to HKD Connecting JFK'],
    ['CONNECTING', 'BDS to HKD CONNECTING JFK'],
    ['Through', 'BDS to HKD Through JFK'],
    ['Stopover', 'BDS to HKD Stopover JFK'],
  ])('rejects %s case variant of chaining keyword', (_label, text) => {
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it('still accepts bare "stop" / "Nonstop" metadata on flight cards', () => {
    // The chain-phrase blockers target chained-route phrases like "stops at"
    // or "with a stop". Bare "stop" / "1 stop" / "Nonstop" remains unblocked
    // because that text appears in legitimate flight-card metadata adjacent
    // to airport codes.
    expect(pageHasRequestedRoute('BDS Brindisi to JFK 1 stop', 'BDS', 'JFK')).toBe(true);
    expect(pageHasRequestedRoute('Flights from BDS to JFK Nonstop', 'BDS', 'JFK')).toBe(true);
  });

  it.each([
    ['stops at', 'BDS to HKD stops at JFK'],
    ['stops in', 'BDS to HKD stops in JFK'],
    ['stop at', 'BDS to HKD stop at JFK'],
    ['stop in', 'BDS to HKD stop in JFK'],
    ['stopping at', 'BDS to HKD stopping at JFK'],
    ['stopping in', 'BDS to HKD stopping in JFK'],
    ['with stop', 'BDS to HKD with stop JFK'],
    ['with a stop', 'BDS to HKD with a stop JFK'],
    ['with stopover', 'BDS to HKD with stopover JFK'],
    ['with a stopover', 'BDS to HKD with a stopover JFK'],
    ['stop over (two words)', 'BDS to HKD stop over JFK'],
    ['stop-over (hyphen)', 'BDS to HKD stop-over JFK'],
    ['connection', 'BDS to HKD connection JFK'],
    ['connection at', 'BDS to HKD connection at JFK'],
    ['connection in', 'BDS to HKD connection in JFK'],
    ['connection through', 'BDS to HKD connection through JFK'],
  ])('rejects chained-route phrase "%s" even with currency-airport overlap', (_label, text) => {
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
  });

  it.each([
    ['Stops At', 'BDS to HKD Stops At JFK'],
    ['STOPPING IN', 'BDS to HKD STOPPING IN JFK'],
    ['With A Stop', 'BDS to HKD With A Stop JFK'],
    ['Connection Through', 'BDS to HKD Connection Through JFK'],
  ])('chain-phrase blockers are case-insensitive (%s)', (_label, text) => {
    expect(pageHasRequestedRoute(text, 'BDS', 'JFK')).toBe(false);
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

// Issue 65: navigateAirlineDirect previously accepted any "currency symbol or
// code + digit" page as having flight prices, including a Turkish stub at
// 1964 chars that just mentioned "EUR pricing" in marketing copy. The
// two-criterion signal requires both currency density (3+ mentions) and at
// least one price-shaped token with letter-boundary protection.
describe('hasFlightPriceSignal (two-criterion airline page heuristic, issue #65)', () => {
  it('rejects a stub page with one EUR mention and no digits', () => {
    expect(hasFlightPriceSignal('Discover EUR fares with flexible booking.')).toBe(false);
  });

  it('rejects a page with TRY embedded in INDUSTRY (lookbehind blocks the mid-word match)', () => {
    expect(hasFlightPriceSignal('Aviation INDUSTRY 2026 entry pricing for the new industry')).toBe(false);
  });

  it('rejects EURO trip (lookahead blocks trailing letter)', () => {
    expect(hasFlightPriceSignal('EURO trip planner 1990 - EURO destinations EURO regions')).toBe(false);
  });

  it('rejects 1-mention text even with a valid price token', () => {
    expect(hasFlightPriceSignal('Get flights from EUR 431 today.')).toBe(false);
  });

  it('rejects 2-mention text', () => {
    expect(hasFlightPriceSignal('Save with EUR pricing and book in EUR easily.')).toBe(false);
  });

  it('accepts a real-shaped airline results page (5+ EUR prices)', () => {
    const text = [
      'BRI to JFK Direct Flight Options',
      'Turkish Airlines EUR 431 - 12h 30m - 1 stop',
      'Lufthansa EUR 522 - 11h 45m - 1 stop',
      'Air France EUR 480 - 13h 10m - 1 stop',
      'KLM EUR 720 - 14h 05m - 2 stops',
      'Alitalia EUR 1,200 - 9h 30m - nonstop',
    ].join('\n');
    expect(hasFlightPriceSignal(text)).toBe(true);
  });

  it('accepts symbol-form prices (€431, €99, €350)', () => {
    expect(hasFlightPriceSignal('€431 / €99 / €350 / €480')).toBe(true);
  });

  it('accepts mixed currency tokens summing to >= 3 mentions', () => {
    expect(hasFlightPriceSignal('USD 431 / EUR 99 / GBP 350')).toBe(true);
  });

  it('rejects a legitimate "no flights available" page with currency in chrome only (3 mentions, no token)', () => {
    const text = 'Change currency: USD EUR GBP. No flights match your search. Try different dates.';
    expect(hasFlightPriceSignal(text)).toBe(false);
  });

  it('accepts EUR99 (no space between code and digits)', () => {
    expect(hasFlightPriceSignal('EUR99 EUR131 EUR205')).toBe(true);
  });
});

describe('buildSkyscannerUrl', () => {
  const base = {
    origin: 'JFK',
    destination: 'LAX',
    dateFrom: new Date('2026-06-15T00:00:00Z'),
    dateTo: new Date('2026-06-22T00:00:00Z'),
  };

  it('builds a round-trip URL with lowercase IATA codes and YYMMDD dates', () => {
    const url = buildSkyscannerUrl(base);
    expect(url).toMatch(/\/jfk\/lax\/260615\/260622\//);
    expect(url).toContain('adultsv2=1');
    expect(url).toContain('cabinclass=economy');
  });

  it('builds a one-way URL with a single date segment', () => {
    const url = buildSkyscannerUrl({ ...base, tripType: 'one_way' });
    expect(url).toMatch(/\/jfk\/lax\/260615\/\?/);
    expect(url).not.toMatch(/260622/);
  });

  it('maps premium_economy cabin to premiumeconomy', () => {
    const url = buildSkyscannerUrl({ ...base, cabinClass: 'premium_economy' });
    expect(url).toContain('cabinclass=premiumeconomy');
  });

  it('defaults to economy when cabinClass is missing', () => {
    const url = buildSkyscannerUrl(base);
    expect(url).toContain('cabinclass=economy');
  });

  it('includes currency and market when set', () => {
    const url = buildSkyscannerUrl({ ...base, currency: 'EUR', country: 'DE' });
    expect(url).toContain('currency=EUR');
    expect(url).toContain('market=DE');
  });

  it('omits currency and market when null', () => {
    const url = buildSkyscannerUrl({ ...base, currency: null, country: null });
    expect(url).not.toContain('currency=');
    expect(url).not.toContain('market=');
  });

  it('rejects invalid origin IATA code', () => {
    expect(() => buildSkyscannerUrl({ ...base, origin: 'jfk' })).toThrow(/Invalid IATA origin/);
  });

  it('rejects invalid destination IATA code', () => {
    expect(() => buildSkyscannerUrl({ ...base, destination: 'JFKK' })).toThrow(/Invalid IATA destination/);
  });
});

describe('buildKayakUrl', () => {
  const base = {
    origin: 'JFK',
    destination: 'LAX',
    dateFrom: new Date('2026-06-15T00:00:00Z'),
    dateTo: new Date('2026-06-22T00:00:00Z'),
  };

  it('builds a round-trip URL with uppercase IATA codes and ISO dates', () => {
    const url = buildKayakUrl(base);
    expect(url).toBe('https://www.kayak.com/flights/JFK-LAX/2026-06-15/2026-06-22?sort=price_a');
  });

  it('builds a one-way URL with a single date segment', () => {
    const url = buildKayakUrl({ ...base, tripType: 'one_way' });
    expect(url).toBe('https://www.kayak.com/flights/JFK-LAX/2026-06-15?sort=price_a');
  });

  it('rejects invalid origin IATA code', () => {
    expect(() => buildKayakUrl({ ...base, origin: 'XX' })).toThrow(/Invalid IATA origin/);
  });

  it('rejects invalid destination IATA code', () => {
    expect(() => buildKayakUrl({ ...base, destination: 'lax' })).toThrow(/Invalid IATA destination/);
  });
});

describe('isAggregatorSource', () => {
  it('accepts all four known sources', () => {
    expect(isAggregatorSource('google_flights')).toBe(true);
    expect(isAggregatorSource('airline_direct')).toBe(true);
    expect(isAggregatorSource('skyscanner')).toBe(true);
    expect(isAggregatorSource('kayak')).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isAggregatorSource('expedia')).toBe(false);
    expect(isAggregatorSource('')).toBe(false);
    expect(isAggregatorSource('GOOGLE_FLIGHTS')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isAggregatorSource(null)).toBe(false);
    expect(isAggregatorSource(undefined)).toBe(false);
    expect(isAggregatorSource(42)).toBe(false);
    expect(isAggregatorSource([])).toBe(false);
  });
});
