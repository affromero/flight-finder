import { describe, it, expect } from 'vitest';
import { groupQueries, type GroupableQuery } from './query-grouping';

function row(overrides: Partial<GroupableQuery> & { id: string }): GroupableQuery {
  return {
    origin: 'JFK',
    destination: 'LAX',
    originName: 'New York',
    destinationName: 'Los Angeles',
    dateFrom: '2026-06-10',
    dateTo: '2026-06-10',
    groupId: null,
    active: true,
    createdAt: '2026-05-01T00:00:00Z',
    snapshotCount: 0,
    lastScrapedAt: null,
    ...overrides,
  };
}

describe('groupQueries', () => {
  it('returns empty array for empty input', () => {
    expect(groupQueries([])).toEqual([]);
  });

  it('treats a single ungrouped row as a one-item group', () => {
    const result = groupQueries([row({ id: 'q1' })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      primaryId: 'q1',
      groupId: null,
      routeCount: 1,
      origin: 'JFK',
      destination: 'LAX',
      dateFrom: '2026-06-10',
      dateTo: '2026-06-10',
    });
  });

  it('collapses N rows sharing a groupId into one group with min/max dates', () => {
    const rows = [
      row({ id: 'q2', groupId: 'g1', dateFrom: '2026-06-12', dateTo: '2026-06-19' }),
      row({ id: 'q1', groupId: 'g1', dateFrom: '2026-06-10', dateTo: '2026-06-17' }),
      row({ id: 'q3', groupId: 'g1', dateFrom: '2026-06-14', dateTo: '2026-06-21' }),
    ];
    const result = groupQueries(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      groupId: 'g1',
      routeCount: 3,
      dateFrom: '2026-06-10',
      dateTo: '2026-06-21',
    });
    // queries are sorted by dateFrom asc
    expect(result[0]!.queries.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
    expect(result[0]!.primaryId).toBe('q1');
  });

  it('uses id.localeCompare as tiebreaker when siblings share dateFrom', () => {
    const rows = [
      row({ id: 'q-beta', groupId: 'g1', dateFrom: '2026-06-10' }),
      row({ id: 'q-alpha', groupId: 'g1', dateFrom: '2026-06-10' }),
    ];
    const result = groupQueries(rows);
    expect(result[0]!.primaryId).toBe('q-alpha');
  });

  it('orders groups by latest createdAt descending', () => {
    const rows = [
      row({ id: 'old', createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'mid-g1-a', groupId: 'g1', createdAt: '2026-03-01T00:00:00Z' }),
      row({ id: 'mid-g1-b', groupId: 'g1', createdAt: '2026-03-02T00:00:00Z' }),
      row({ id: 'new', createdAt: '2026-05-01T00:00:00Z' }),
    ];
    const result = groupQueries(rows);
    expect(result.map((g) => g.primaryId)).toEqual(['new', 'mid-g1-a', 'old']);
  });

  it('exposes unique destinations/origins arrays', () => {
    const rows = [
      row({ id: 'q1', groupId: 'g1', destination: 'NRT', destinationName: 'Tokyo' }),
      row({ id: 'q2', groupId: 'g1', destination: 'ICN', destinationName: 'Seoul' }),
      row({ id: 'q3', groupId: 'g1', destination: 'NRT', destinationName: 'Tokyo' }),
    ];
    const result = groupQueries(rows);
    expect(result[0]!.destinations).toEqual([
      { code: 'NRT', name: 'Tokyo' },
      { code: 'ICN', name: 'Seoul' },
    ]);
    expect(result[0]!.origins).toEqual([{ code: 'JFK', name: 'New York' }]);
    // primary destination follows queries[0]
    expect(result[0]!.destination).toBe('NRT');
  });

  it('reflects multi-origin groups symmetrically', () => {
    const rows = [
      row({ id: 'q1', groupId: 'g1', origin: 'JFK', originName: 'New York' }),
      row({ id: 'q2', groupId: 'g1', origin: 'EWR', originName: 'Newark' }),
    ];
    const result = groupQueries(rows);
    expect(result[0]!.origins).toEqual([
      { code: 'JFK', name: 'New York' },
      { code: 'EWR', name: 'Newark' },
    ]);
  });

  it('computes anyActive and anyPaused across mixed sibling states', () => {
    const mixed = groupQueries([
      row({ id: 'q1', groupId: 'g1', active: true }),
      row({ id: 'q2', groupId: 'g1', active: false }),
    ]);
    expect(mixed[0]).toMatchObject({ anyActive: true, anyPaused: true });

    const allActive = groupQueries([
      row({ id: 'q1', groupId: 'g2', active: true }),
      row({ id: 'q2', groupId: 'g2', active: true }),
    ]);
    expect(allActive[0]).toMatchObject({ anyActive: true, anyPaused: false });
  });

  it('flags allExpired only when every member is past its expiresAt', () => {
    const expired = groupQueries([
      row({ id: 'q1', groupId: 'g1', expiresAt: '2024-01-01T00:00:00Z' }),
      row({ id: 'q2', groupId: 'g1', expiresAt: '2024-02-01T00:00:00Z' }),
    ]);
    expect(expired[0]!.allExpired).toBe(true);

    const mixed = groupQueries([
      row({ id: 'q1', groupId: 'g2', expiresAt: '2024-01-01T00:00:00Z' }),
      row({ id: 'q2', groupId: 'g2', expiresAt: '2999-01-01T00:00:00Z' }),
    ]);
    expect(mixed[0]!.allExpired).toBe(false);

    const noExpiry = groupQueries([row({ id: 'q1', groupId: 'g3' })]);
    expect(noExpiry[0]!.allExpired).toBe(false);
  });

  it('sums snapshotCount and tracks the latest lastScrapedAt', () => {
    const result = groupQueries([
      row({ id: 'q1', groupId: 'g1', snapshotCount: 5, lastScrapedAt: '2026-05-01T08:00:00Z' }),
      row({ id: 'q2', groupId: 'g1', snapshotCount: 7, lastScrapedAt: '2026-05-02T08:00:00Z' }),
      row({ id: 'q3', groupId: 'g1', snapshotCount: 0, lastScrapedAt: null }),
    ]);
    expect(result[0]!.snapshotCount).toBe(12);
    expect(result[0]!.lastScrapedAt).toBe('2026-05-02T08:00:00Z');
  });

  it('handles rows with undefined optional fields without throwing', () => {
    const minimal: GroupableQuery = {
      id: 'q1',
      origin: 'JFK',
      destination: 'LAX',
      dateFrom: '2026-06-10',
      dateTo: '2026-06-10',
      groupId: null,
    };
    const result = groupQueries([minimal]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      snapshotCount: 0,
      lastScrapedAt: null,
      anyActive: false,
      anyPaused: false,
      allExpired: false,
      originName: 'JFK',
      destinationName: 'LAX',
    });
  });
});
