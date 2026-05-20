/**
 * Collapse a flat list of `Query` rows into one entry per `groupId` so the
 * dashboard lists show one card for a flex search even when the create
 * handler fanned it out into N sibling queries. Ungrouped rows
 * (`groupId === null`) each become a single-item group, so consumers can
 * iterate without branching.
 */

export interface GroupableQuery {
  id: string;
  origin: string;
  destination: string;
  originName?: string;
  destinationName?: string;
  dateFrom: string;
  dateTo: string;
  groupId: string | null;
  active?: boolean;
  expiresAt?: string;
  scrapeInterval?: number | null;
  snapshotCount?: number;
  lastScrapedAt?: string | null;
  createdAt?: string;
}

export interface QueryGroup<T extends GroupableQuery> {
  primaryId: string;
  groupId: string | null;
  origin: string;
  destination: string;
  originName: string;
  destinationName: string;
  origins: Array<{ code: string; name: string }>;
  destinations: Array<{ code: string; name: string }>;
  dateFrom: string;
  dateTo: string;
  routeCount: number;
  snapshotCount: number;
  lastScrapedAt: string | null;
  anyActive: boolean;
  anyPaused: boolean;
  allExpired: boolean;
  scrapeInterval: number | null;
  queries: T[];
}

function uniquePairs(
  rows: GroupableQuery[],
  codeKey: 'origin' | 'destination',
  nameKey: 'originName' | 'destinationName',
): Array<{ code: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ code: string; name: string }> = [];
  for (const row of rows) {
    const code = row[codeKey];
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: row[nameKey] ?? code });
  }
  return out;
}

export function groupQueries<T extends GroupableQuery>(rows: T[]): QueryGroup<T>[] {
  if (rows.length === 0) return [];

  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.groupId ?? `solo:${row.id}`;
    const list = buckets.get(key);
    if (list) {
      list.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  const now = Date.now();
  const groups: QueryGroup<T>[] = [];

  for (const queries of buckets.values()) {
    queries.sort((a, b) => {
      if (a.dateFrom !== b.dateFrom) return a.dateFrom < b.dateFrom ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    const primary = queries[0]!;
    const dateFromValues = queries.map((q) => q.dateFrom);
    const dateToValues = queries.map((q) => q.dateTo);
    const dateFrom = dateFromValues.reduce((a, b) => (a < b ? a : b));
    const dateTo = dateToValues.reduce((a, b) => (a > b ? a : b));

    const snapshotCount = queries.reduce((sum, q) => sum + (q.snapshotCount ?? 0), 0);

    let lastScrapedAt: string | null = null;
    for (const q of queries) {
      if (!q.lastScrapedAt) continue;
      if (lastScrapedAt === null || q.lastScrapedAt > lastScrapedAt) {
        lastScrapedAt = q.lastScrapedAt;
      }
    }

    const anyActive = queries.some((q) => q.active === true);
    const anyPaused = queries.some((q) => q.active === false);

    const expiresValues = queries
      .map((q) => q.expiresAt)
      .filter((v): v is string => typeof v === 'string');
    const allExpired = expiresValues.length > 0
      && expiresValues.every((v) => new Date(v).getTime() <= now);

    groups.push({
      primaryId: primary.id,
      groupId: primary.groupId,
      origin: primary.origin,
      destination: primary.destination,
      originName: primary.originName ?? primary.origin,
      destinationName: primary.destinationName ?? primary.destination,
      origins: uniquePairs(queries, 'origin', 'originName'),
      destinations: uniquePairs(queries, 'destination', 'destinationName'),
      dateFrom,
      dateTo,
      routeCount: queries.length,
      snapshotCount,
      lastScrapedAt,
      anyActive,
      anyPaused,
      allExpired,
      scrapeInterval: primary.scrapeInterval ?? null,
      queries,
    });
  }

  // Sort groups by their most recent createdAt descending so the newest
  // tracker floats to the top of the list (matching prior list ordering).
  // When createdAt is missing on every member, preserve insertion order.
  groups.sort((a, b) => {
    const aCreated = a.queries.reduce<string | null>(
      (max, q) => (q.createdAt && (max === null || q.createdAt > max) ? q.createdAt : max),
      null,
    );
    const bCreated = b.queries.reduce<string | null>(
      (max, q) => (q.createdAt && (max === null || q.createdAt > max) ? q.createdAt : max),
      null,
    );
    if (aCreated === null && bCreated === null) return 0;
    if (aCreated === null) return 1;
    if (bCreated === null) return -1;
    return aCreated < bCreated ? 1 : aCreated > bCreated ? -1 : 0;
  });

  return groups;
}
