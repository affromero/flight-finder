import { describe, it, expect } from 'vitest';
import {
  airTimeMinutes,
  coerceLayovers,
  formatMinutes,
  layoverLabel,
  layoverMinutes,
  parseDurationToMinutes,
} from './duration';

describe('parseDurationToMinutes', () => {
  it('parses hours and minutes', () => {
    expect(parseDurationToMinutes('11h 20m')).toBe(11 * 60 + 20);
  });

  it('parses hours only', () => {
    expect(parseDurationToMinutes('2h')).toBe(120);
  });

  it('parses minutes only', () => {
    expect(parseDurationToMinutes('45m')).toBe(45);
  });

  it('returns null for empty string', () => {
    expect(parseDurationToMinutes('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseDurationToMinutes(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseDurationToMinutes(undefined)).toBeNull();
  });

  it('returns null when no h or m markers are present', () => {
    expect(parseDurationToMinutes('abc')).toBeNull();
    expect(parseDurationToMinutes('11')).toBeNull();
  });

  it('also parses ISO 8601 PT12H30M as a side effect of the loose regex', () => {
    // This is incidental: the regex matches the H and M markers.
    expect(parseDurationToMinutes('PT12H30M')).toBe(12 * 60 + 30);
  });

  it('handles uppercase H and M', () => {
    expect(parseDurationToMinutes('5H 10M')).toBe(310);
  });
});

describe('formatMinutes', () => {
  it('renders hours and minutes, dropping the zero part', () => {
    expect(formatMinutes(95)).toBe('1h 35m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(45)).toBe('45m');
  });
});

describe('coerceLayovers', () => {
  it('keeps well-formed objects, normalizing the duration', () => {
    expect(coerceLayovers([{ duration: '1 hr 35 min', airport: 'ORD' }])).toEqual([
      { duration: '1h 35m', airport: 'ORD' },
    ]);
  });

  it('parses the raw layover line straight off the page', () => {
    expect(coerceLayovers(['1 hr 35 min layover · Chicago ORD'])).toEqual([
      { duration: '1h 35m', airport: 'Chicago ORD' },
    ]);
    expect(coerceLayovers('55 min in ATL')).toEqual([{ duration: '55m', airport: 'ATL' }]);
  });

  it('accepts the aliases and numeric minutes models actually emit', () => {
    expect(coerceLayovers([{ layoverDuration: '2h', city: 'Dallas' }])).toEqual([
      { duration: '2h', airport: 'Dallas' },
    ]);
    expect(coerceLayovers([{ duration: 95, code: 'ORD' }])).toEqual([{ duration: '1h 35m', airport: 'ORD' }]);
  });

  it('returns null when nothing usable is there', () => {
    expect(coerceLayovers(null)).toBeNull();
    expect(coerceLayovers([])).toBeNull();
    expect(coerceLayovers('nonstop')).toBeNull();
    expect(coerceLayovers([{ airport: 'ORD' }])).toBeNull();
    expect(coerceLayovers([{ duration: '0m', airport: 'ORD' }])).toBeNull();
  });

  it('drops unusable entries but keeps the rest of the itinerary', () => {
    expect(coerceLayovers([{ duration: '1h', airport: 'ORD' }, 'no idea', { duration: '40m' }])).toEqual([
      { duration: '1h', airport: 'ORD' },
      { duration: '40m', airport: null },
    ]);
  });

  it('bounds entry count and airport length against hostile input', () => {
    const many = Array.from({ length: 20 }, () => ({ duration: '1h', airport: 'X' }));
    expect(coerceLayovers(many)).toHaveLength(6);
    expect(coerceLayovers([{ duration: '1h', airport: 'A'.repeat(500) }])![0]!.airport).toHaveLength(40);
  });
});

describe('layover totals', () => {
  const twoStop = [
    { duration: '1h 35m', airport: 'ORD' },
    { duration: '45m', airport: 'DFW' },
  ];

  it('sums ground time across connections', () => {
    expect(layoverMinutes(twoStop)).toBe(140);
    expect(layoverMinutes(null)).toBeNull();
  });

  it('reports air time as duration minus ground time', () => {
    expect(airTimeMinutes('5h 55m', [{ duration: '1h 35m', airport: 'ORD' }])).toBe(4 * 60 + 20);
  });

  it('refuses to report air time when the numbers cannot both be right', () => {
    expect(airTimeMinutes('1h', [{ duration: '2h', airport: 'ORD' }])).toBeNull();
    expect(airTimeMinutes(null, twoStop)).toBeNull();
    expect(airTimeMinutes('5h', null)).toBeNull();
  });

  it('labels the total with the airports it knows', () => {
    expect(layoverLabel(twoStop)).toBe('2h 20m ORD, DFW');
    expect(layoverLabel([{ duration: '1h', airport: null }])).toBe('1h');
    expect(layoverLabel(null)).toBeNull();
  });
});
