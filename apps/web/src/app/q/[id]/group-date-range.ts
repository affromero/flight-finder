/**
 * Travel window across every row in a flex group. Each sibling in a flex
 * group stores a single pinned date (dateFrom == dateTo), so the union of
 * their dates is the only correct way to summarise the window in the page
 * header and the OpenGraph share card. Lives in its own module so the
 * regression test can run without pulling in next/navigation or prisma
 * from page.tsx.
 */
export function groupDateRange(rows: Array<{ dateFrom: Date; dateTo: Date }>): { dateFrom: Date; dateTo: Date } {
  if (rows.length === 0) {
    throw new Error('groupDateRange requires at least one row');
  }
  let from = rows[0]!.dateFrom;
  let to = rows[0]!.dateTo;
  for (const row of rows) {
    if (row.dateFrom.getTime() < from.getTime()) from = row.dateFrom;
    if (row.dateTo.getTime() > to.getTime()) to = row.dateTo;
  }
  return { dateFrom: from, dateTo: to };
}
