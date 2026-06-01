import { prisma } from '@/lib/prisma';

/**
 * Deactivate trackers whose departure day has already passed. A trip is
 * unbookable once its outbound (dateFrom) date is in the past, so there is no
 * point scraping it. The cutoff is midnight UTC today, so a flight departing
 * today survives until tomorrow. Seeds are left alone (they have no real
 * departure). Returns the number of trackers expired.
 */
export async function expireDepartedQueries(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await prisma.query.updateMany({
    where: { active: true, isSeed: false, dateFrom: { lt: todayStart } },
    data: { active: false },
  });
  return result.count;
}
