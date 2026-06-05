import { apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { getCronInfo } from '@/lib/cron';
import { verifyAdminSessionRevocable } from '@/lib/admin-guard';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [activeQueries, totalScrapes, totalPricePoints, costResult] = await Promise.all([
    prisma.query.count({
      where: { active: true, isSeed: false, expiresAt: { gt: new Date() } },
    }),
    prisma.fetchRun.count(),
    prisma.priceSnapshot.count(),
    (async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return prisma.apiUsageLog.aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: thirtyDaysAgo } },
      });
    })(),
  ]);

  const cron = getCronInfo();

  // Only expose cost data to authenticated admins. The landing page widget uses
  // activeQueries, totalScrapes, totalPricePoints, and cron -- none of which
  // are sensitive. llmCost30d is an internal financial metric. Use the
  // revocation-aware check so a token issued before the last admin password
  // change does not keep seeing cost for up to 7 days.
  const isAdmin = await verifyAdminSessionRevocable();

  const publicData = { activeQueries, totalScrapes, totalPricePoints, cron };

  if (!isAdmin) {
    return apiSuccess(publicData);
  }

  return apiSuccess({
    ...publicData,
    llmCost30d: Math.round((costResult._sum.costUsd ?? 0) * 100) / 100,
  });
}
