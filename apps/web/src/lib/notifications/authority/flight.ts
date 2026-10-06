import { createHash } from 'node:crypto';
import type { Prisma, Query } from '@/generated/prisma/client';

/** Notification runtime state is separate from scraper criteria authority. */
export function criteriaVersion(query: Query): string {
  const metadata = new Set(['updatedAt', 'firstViewedAt', 'lastNotifiedLowPrice', 'lastNotifiedAt']);
  const criteria = Object.entries(query).filter(([key]) => !metadata.has(key)).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(criteria)).digest('hex');
}

export async function notificationBaselineFrom(tx: Prisma.TransactionClient, query: Query, baselineCutoff?: Date | null) {
  const edit = await tx.queryEditEvent.findFirst({ where: { queryId: query.id }, orderBy: { editedAt: 'desc' }, select: { editedAt: true } });
  const cutoff = baselineCutoff === undefined
    ? (await tx.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { cabinAlertBaselineCutoff: true } }))?.cabinAlertBaselineCutoff
    : baselineCutoff;
  const boundaries = [edit?.editedAt, query.cabinClass !== 'economy' ? cutoff : null].filter((date): date is Date => Boolean(date));
  return boundaries.length ? new Date(Math.max(...boundaries.map(date => date.getTime()))) : null;
}
