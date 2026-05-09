import { describe, it, expect } from 'vitest';
import { getAirlineUrl, isKnownAirline, getKnownAirlines } from './airline-urls';
import type { FlightSearchParams } from './navigate';

const baseRT: FlightSearchParams = {
  origin: 'JFK',
  destination: 'LAX',
  dateFrom: new Date('2026-06-15'),
  dateTo: new Date('2026-06-22'),
  tripType: 'round_trip',
};

const baseOW: FlightSearchParams = {
  origin: 'JFK',
  destination: 'LAX',
  dateFrom: new Date('2026-06-15'),
  dateTo: new Date('2026-06-15'),
  tripType: 'one_way',
};

const RETURN_KEY_PATTERN = /^(returnDate|return|inbound|inboundDate|dateIn|departure2|destination2|origin2)$/i;

function paramKeys(url: string): string[] {
  return Array.from(new URL(url).searchParams.keys());
}

describe('getAirlineUrl basics', () => {
  it('returns url for known airline', () => {
    const url = getAirlineUrl('delta', baseRT);
    expect(url).not.toBeNull();
    expect(url).toContain('delta.com');
    expect(url).toContain('JFK');
    expect(url).toContain('LAX');
  });

  it('resolves IATA alias', () => {
    expect(getAirlineUrl('DL', baseRT)).toContain('delta.com');
  });

  it('resolves full name alias', () => {
    expect(getAirlineUrl('American Airlines', baseRT)).toContain('aa.com');
  });

  it('returns null for unknown airline', () => {
    expect(getAirlineUrl('FlyByNight', baseRT)).toBeNull();
  });

  it('normalizes case and whitespace', () => {
    expect(getAirlineUrl('  DELTA  ', baseRT)).toContain('delta.com');
  });

  it('formats outbound date as yyyy-mm-dd', () => {
    const url = getAirlineUrl('delta', baseRT)!;
    expect(url).toContain('2026-06-15');
  });

  it('throws on invalid IATA origin', () => {
    expect(() => getAirlineUrl('delta', { ...baseRT, origin: 'NOT_IATA' })).toThrow(/Invalid IATA origin/);
  });

  it('throws on invalid IATA destination', () => {
    expect(() => getAirlineUrl('delta', { ...baseRT, destination: 'lax' })).toThrow(/Invalid IATA destination/);
  });
});

describe('round-trip URLs include return date', () => {
  // Avianca uses departure2 for the return leg, not returnDate. Other carriers
  // use one of: returnDate, return, inbound, inboundDate, dateIn.
  it.each(getKnownAirlines())('%s round-trip URL contains return-leg encoding', (airline) => {
    const url = getAirlineUrl(airline, baseRT)!;
    const keys = paramKeys(url);
    const hasReturnLeg = keys.some((k) => RETURN_KEY_PATTERN.test(k));
    expect(hasReturnLeg).toBe(true);
    expect(url).toContain('2026-06-22');
  });
});

describe('one-way URLs do not leak return-leg parameters (issue #65)', () => {
  it.each(getKnownAirlines())('%s one-way URL has no return-date-shaped param', (airline) => {
    const url = getAirlineUrl(airline, baseOW)!;
    const keys = paramKeys(url);
    const leaked = keys.filter((k) => RETURN_KEY_PATTERN.test(k));
    expect(leaked).toEqual([]);
    // And no second occurrence of the dateTo (which equals dateFrom in oneway).
    // Specifically, the return-leg key must be absent regardless of value.
  });

  it.each(getKnownAirlines())('%s one-way URL still contains origin and destination', (airline) => {
    const url = getAirlineUrl(airline, baseOW)!;
    expect(url).toContain('JFK');
    expect(url).toContain('LAX');
    expect(url).toContain('2026-06-15');
  });
});

describe('per-airline tripType token (the 3 carriers that encode it)', () => {
  it('southwest one-way has tripType=oneway', () => {
    const url = new URL(getAirlineUrl('southwest', baseOW)!);
    expect(url.searchParams.get('tripType')).toBe('oneway');
  });

  it('southwest round-trip has tripType=roundtrip', () => {
    const url = new URL(getAirlineUrl('southwest', baseRT)!);
    expect(url.searchParams.get('tripType')).toBe('roundtrip');
  });

  it('delta one-way has tripType=ONE_WAY', () => {
    const url = new URL(getAirlineUrl('delta', baseOW)!);
    expect(url.searchParams.get('tripType')).toBe('ONE_WAY');
  });

  it('delta round-trip has tripType=ROUND_TRIP', () => {
    const url = new URL(getAirlineUrl('delta', baseRT)!);
    expect(url.searchParams.get('tripType')).toBe('ROUND_TRIP');
  });

  it('american one-way has type=oneWay', () => {
    const url = new URL(getAirlineUrl('american', baseOW)!);
    expect(url.searchParams.get('type')).toBe('oneWay');
  });

  it('american round-trip has type=roundTrip', () => {
    const url = new URL(getAirlineUrl('american', baseRT)!);
    expect(url.searchParams.get('type')).toBe('roundTrip');
  });
});

describe('cabin and currency still propagate for one-way', () => {
  it('delta one-way with business cabin keeps BUSINESS', () => {
    const url = getAirlineUrl('delta', { ...baseOW, cabinClass: 'business' })!;
    expect(url).toContain('BUSINESS');
  });

  it('avianca round-trip propagates currency', () => {
    const url = new URL(getAirlineUrl('avianca', { ...baseRT, currency: 'COP' })!);
    expect(url.searchParams.get('currency')).toBe('COP');
  });

  it('avianca one-way propagates currency', () => {
    const url = new URL(getAirlineUrl('avianca', { ...baseOW, currency: 'COP' })!);
    expect(url.searchParams.get('currency')).toBe('COP');
  });

  it('avianca one-way URL has no origin2/destination2/departure2', () => {
    const url = new URL(getAirlineUrl('avianca', baseOW)!);
    expect(url.searchParams.has('origin2')).toBe(false);
    expect(url.searchParams.has('destination2')).toBe(false);
    expect(url.searchParams.has('departure2')).toBe(false);
  });

  it('avianca round-trip URL has origin2/destination2/departure2', () => {
    const url = new URL(getAirlineUrl('avianca', baseRT)!);
    expect(url.searchParams.get('origin2')).toBe('LAX');
    expect(url.searchParams.get('destination2')).toBe('JFK');
    expect(url.searchParams.get('departure2')).toBe('2026-06-22');
  });
});

describe('isKnownAirline', () => {
  it('returns true for known airline', () => {
    expect(isKnownAirline('southwest')).toBe(true);
  });

  it('returns true for alias', () => {
    expect(isKnownAirline('BA')).toBe(true);
  });

  it('returns false for unknown', () => {
    expect(isKnownAirline('FlyByNight')).toBe(false);
  });
});

describe('getKnownAirlines', () => {
  it('returns all airlines', () => {
    const airlines = getKnownAirlines();
    expect(airlines.length).toBeGreaterThanOrEqual(25);
    expect(airlines).toContain('delta');
    expect(airlines).toContain('ryanair');
    expect(airlines).toContain('emirates');
  });

  it('returns canonical names not aliases', () => {
    const airlines = getKnownAirlines();
    expect(airlines).not.toContain('DL');
    expect(airlines).not.toContain('AA');
  });
});
