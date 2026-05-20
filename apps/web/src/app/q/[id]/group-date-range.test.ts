import { describe, it, expect } from 'vitest';
import { groupDateRange } from './group-date-range';

function row(from: string, to: string) {
  return { dateFrom: new Date(from), dateTo: new Date(to) };
}

describe('groupDateRange', () => {
  it('returns the row dates verbatim for a single row', () => {
    const result = groupDateRange([row('2026-11-07', '2026-11-07')]);
    expect(result.dateFrom).toEqual(new Date('2026-11-07'));
    expect(result.dateTo).toEqual(new Date('2026-11-07'));
  });

  it('regression #78: 4 flex siblings with pinned single-day dates span the union (Nov 7 to Nov 11)', () => {
    // Issue #78 follow-up: header used to read the primary sibling alone
    // which gave "Nov 7, 2026 - Nov 7, 2026" instead of the real window.
    const result = groupDateRange([
      row('2026-11-07', '2026-11-07'),
      row('2026-11-08', '2026-11-08'),
      row('2026-11-09', '2026-11-09'),
      row('2026-11-11', '2026-11-11'),
    ]);
    expect(result.dateFrom).toEqual(new Date('2026-11-07'));
    expect(result.dateTo).toEqual(new Date('2026-11-11'));
  });

  it('handles a round trip flex group where each sibling spans outbound to return', () => {
    const result = groupDateRange([
      row('2026-11-07', '2026-11-14'),
      row('2026-11-09', '2026-11-16'),
      row('2026-11-11', '2026-11-18'),
    ]);
    expect(result.dateFrom).toEqual(new Date('2026-11-07'));
    expect(result.dateTo).toEqual(new Date('2026-11-18'));
  });

  it('is order independent', () => {
    const ascending = groupDateRange([
      row('2026-11-07', '2026-11-07'),
      row('2026-11-08', '2026-11-08'),
      row('2026-11-09', '2026-11-09'),
    ]);
    const descending = groupDateRange([
      row('2026-11-09', '2026-11-09'),
      row('2026-11-08', '2026-11-08'),
      row('2026-11-07', '2026-11-07'),
    ]);
    expect(ascending).toEqual(descending);
  });

  it('throws on empty input', () => {
    expect(() => groupDateRange([])).toThrow(/at least one row/);
  });
});
