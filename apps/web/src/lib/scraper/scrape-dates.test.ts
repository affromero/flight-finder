import { describe, it, expect } from 'vitest';
import {
  expandQueryDates,
  expandContinuousRangeToDates,
  previewRoundTripGridForCombos,
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

  it('flex=2 over an 11-day trip emits 9 pairs (3x3 grid)', () => {
    // Intent: outbound around Jun 15 +/- 2, return around Jun 22 +/- 2.
    // Storage: dateFrom=Jun 13, dateTo=Jun 24 (= 22+2).
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-13'),
      dateTo: D('2026-06-24'),
      flexibility: 2,
      tripType: 'round_trip',
    });
    expect(pairs).toHaveLength(9);

    const outboundDays = new Set(pairs.map((p) => iso(p.outbound)));
    const returnDays = new Set(pairs.map((p) => iso(p.return_)));
    expect(outboundDays).toEqual(new Set(['2026-06-13', '2026-06-15', '2026-06-17']));
    expect(returnDays).toEqual(new Set(['2026-06-20', '2026-06-22', '2026-06-24']));

    // Every pair must have outbound <= return.
    for (const p of pairs) {
      expect(p.outbound.getTime()).toBeLessThanOrEqual(p.return_.getTime());
    }
  });

  it('tight window (flex > gap) clamps and produces valid pairs', () => {
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-15'),
      dateTo: D('2026-06-16'),
      flexibility: 5,
      tripType: 'round_trip',
    });
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const p of pairs) {
      const o = iso(p.outbound);
      const r = iso(p.return_);
      expect(o >= '2026-06-15' && o <= '2026-06-16').toBe(true);
      expect(r >= '2026-06-15' && r <= '2026-06-16').toBe(true);
      expect(p.outbound.getTime()).toBeLessThanOrEqual(p.return_.getTime());
    }
  });

  it('dedupes when grid cells coincide', () => {
    // flex=1 on a tight window where outbound and return windows overlap
    // entirely: every outbound choice equals every return choice (after
    // outbound <= return filter, only the diagonal pairs survive).
    const pairs = expandQueryDates({
      dateFrom: D('2026-06-15'),
      dateTo: D('2026-06-15'),
      flexibility: 1,
      tripType: 'round_trip',
    });
    const keys = pairs.map((p) => `${iso(p.outbound)}|${iso(p.return_)}`);
    expect(new Set(keys).size).toBe(keys.length);
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

describe('previewRoundTripGridForCombos', () => {
  it('1 combo allows 4x4 grid', () => {
    expect(previewRoundTripGridForCombos(1)).toBe(4);
  });

  it('6 combos allows 2x2 grid (4 pairs, 24 tasks)', () => {
    expect(previewRoundTripGridForCombos(6)).toBe(2);
  });

  it('25 combos clamps to 1', () => {
    expect(previewRoundTripGridForCombos(25)).toBe(1);
  });

  it('0 combos defaults to 1 (defensive)', () => {
    expect(previewRoundTripGridForCombos(0)).toBe(1);
  });
});
