import { describe, it, expect } from 'vitest';
import { aggregateScrapeStatus, type SiblingScrape } from './scrape-status';

function sib(overrides: Partial<SiblingScrape>): SiblingScrape {
  return { status: null, error: null, startedAt: null, ...overrides };
}

describe('aggregateScrapeStatus', () => {
  it('returns nulls for empty input', () => {
    expect(aggregateScrapeStatus([])).toEqual({
      status: null,
      error: null,
      startedAt: null,
      failingSiblings: 0,
    });
  });

  it('returns success when every sibling succeeded', () => {
    const result = aggregateScrapeStatus([
      sib({ status: 'success', startedAt: '2026-05-20T10:00:00Z' }),
      sib({ status: 'success', startedAt: '2026-05-20T11:00:00Z' }),
    ]);
    expect(result.status).toBe('success');
    expect(result.failingSiblings).toBe(0);
    expect(result.startedAt).toBe('2026-05-20T11:00:00Z');
  });

  it('surfaces failed over success and counts failing siblings', () => {
    const result = aggregateScrapeStatus([
      sib({ status: 'success', startedAt: '2026-05-20T10:00:00Z' }),
      sib({ status: 'failed', error: 'rate limit', startedAt: '2026-05-20T11:00:00Z' }),
      sib({ status: 'success', startedAt: '2026-05-20T12:00:00Z' }),
    ]);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('rate limit');
    expect(result.failingSiblings).toBe(1);
    expect(result.startedAt).toBe('2026-05-20T12:00:00Z');
  });

  it('in_progress wins over failed (active refresh masks stale failures)', () => {
    const result = aggregateScrapeStatus([
      sib({ status: 'failed', error: 'old error', startedAt: '2026-05-19T10:00:00Z' }),
      sib({ status: 'in_progress', startedAt: '2026-05-20T11:00:00Z' }),
    ]);
    expect(result.status).toBe('in_progress');
    expect(result.failingSiblings).toBe(1);
  });

  it('treats null status as missing and still picks success when present', () => {
    const result = aggregateScrapeStatus([
      sib({ status: null }),
      sib({ status: 'success', startedAt: '2026-05-20T10:00:00Z' }),
    ]);
    expect(result.status).toBe('success');
  });

  it('returns null status when every sibling is null', () => {
    const result = aggregateScrapeStatus([sib({}), sib({})]);
    expect(result.status).toBeNull();
  });

  it('partial sits between failed and success', () => {
    const result = aggregateScrapeStatus([
      sib({ status: 'success', startedAt: '2026-05-20T10:00:00Z' }),
      sib({ status: 'partial', startedAt: '2026-05-20T11:00:00Z' }),
    ]);
    expect(result.status).toBe('partial');
  });

  it('coerces unknown status strings to null', () => {
    const result = aggregateScrapeStatus([
      sib({ status: 'something_weird' as never }),
      sib({ status: 'success', startedAt: '2026-05-20T10:00:00Z' }),
    ]);
    expect(result.status).toBe('success');
  });
});
