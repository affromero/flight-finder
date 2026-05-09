import { describe, it, expect } from 'vitest';
import {
  expandQueryDates,
  expandContinuousRangeToDates,
} from './scrape-dates';

const D = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('expandQueryDates one-way', () => {
  it('single-day query (flex=0) emits one pair', () => {
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-15'),
      dateTo: D('2026-06-15'),
      flexibility: 0,
      tripType: 'one_way',
    });
    expect(pairs).toHaveLength(1);
    expect(iso(pairs[0]!.outbound)).toBe('2026-06-15');
    expect(iso(pairs[0]!.return_)).toBe('2026-06-15');
  });

  it('5-day window (flex=2) emits 5 pairs covering every day', () => {
    const pairs = expandQueryDates({
      dateFrom: D('2026-11-07'),
      dateTo: D('2026-11-11'),
      flexibility: 2,
      tripType: 'one_way',
    });
    expect(pairs.map((p) => iso(p.outbound))).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
    for (const p of pairs) {
      expect(iso(p.outbound)).toBe(iso(p.return_));
    }
  });

  it('large window (flex=15, 31 days) is capped at 7 evenly-spaced pairs', () => {
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-15'),
      dateTo: D('2026-07-15'),
      flexibility: 15,
      tripType: 'one_way',
    });
    expect(pairs).toHaveLength(7);
    expect(iso(pairs[0]!.outbound)).toBe('2026-06-15');
    expect(iso(pairs[6]!.outbound)).toBe('2026-07-15');
    // Roughly evenly spaced (5-day stride for a 30-day span across 6 gaps).
    const gaps = pairs.slice(1).map((p, i) => {
      const prev = pairs[i]!.outbound;
      return Math.round((p.outbound.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
    });
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(4);
      expect(g).toBeLessThanOrEqual(6);
    }
  });

  it('respects custom oneWayCap', () => {
    const pairs = expandQueryDates(
      {
        dateFrom: D('2026-06-15'),
        dateTo: D('2026-07-15'),
        flexibility: 15,
        tripType: 'one_way',
      },
      { oneWayCap: 3 },
    );
    expect(pairs).toHaveLength(3);
  });
});

describe('expandQueryDates round-trip', () => {
  // Round-trip always emits a single (dateFrom, dateTo) pair. Iterating per
  // pair would collapse same-outbound flights with different returns at the
  // flightId/dedupe layer; that requires a returnTravelDate column on
  // PriceSnapshot which is out of scope for this fix.
  it('flex=0 emits a single (dateFrom, dateTo) pair', () => {
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-15'),
      dateTo: D('2026-06-22'),
      flexibility: 0,
      tripType: 'round_trip',
    });
    expect(pairs).toHaveLength(1);
    expect(iso(pairs[0]!.outbound)).toBe('2026-06-15');
    expect(iso(pairs[0]!.return_)).toBe('2026-06-22');
  });

  it('flex>0 still emits a single (dateFrom, dateTo) pair (RT iteration deferred)', () => {
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-13'),
      dateTo: D('2026-06-24'),
      flexibility: 2,
      tripType: 'round_trip',
    });
    expect(pairs).toHaveLength(1);
    expect(iso(pairs[0]!.outbound)).toBe('2026-06-13');
    expect(iso(pairs[0]!.return_)).toBe('2026-06-24');
  });
});

describe('expandContinuousRangeToDates', () => {
  it('returns every day for short ranges', () => {
    expect(expandContinuousRangeToDates('2026-06-15', '2026-06-19')).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
    ]);
  });

  it('caps at 7 evenly-spaced dates for wide ranges', () => {
    const dates = expandContinuousRangeToDates('2026-06-15', '2026-07-15');
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-06-15');
    expect(dates[6]).toBe('2026-07-15');
  });

  it('respects custom cap', () => {
    const dates = expandContinuousRangeToDates('2026-06-15', '2026-07-15', 3);
    expect(dates).toHaveLength(3);
    expect(dates[0]).toBe('2026-06-15');
    expect(dates[2]).toBe('2026-07-15');
  });

  it('returns single date when dateFrom == dateTo', () => {
    expect(expandContinuousRangeToDates('2026-06-15', '2026-06-15')).toEqual(['2026-06-15']);
  });

  it('returns single date for inverted range (defensive)', () => {
    expect(expandContinuousRangeToDates('2026-06-19', '2026-06-15')).toEqual(['2026-06-19']);
  });
});

