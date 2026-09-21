import { apiError, apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentProfile } from '@/lib/user-auth';
import type { Prisma } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const multiUser = await isMultiUserEnabled();

  let userFilter: Prisma.QueryWhereInput = {};
  if (multiUser) {
    const user = await getCurrentProfile();
    if (!user) return apiError('Unauthorized', 401);
    userFilter = user.isAdmin ? { OR: [{ userId: user.id }, { userId: null }] } : { userId: user.id };
  }

  // Get active non-seed queries, scoped to the current user in multi-user mode
  const queries = await prisma.query.findMany({
    where: {
      active: true,
      isSeed: false,
      expiresAt: { gt: new Date() },
      ...userFilter,
    },
    select: {
      id: true,
      origin: true,
      destination: true,
      currency: true,
      fetchRuns: {
        where: { status: 'success' },
        orderBy: { startedAt: 'desc' },
        take: 2,
        select: { id: true, startedAt: true },
      },
    },
  });

  const alerts: Array<{
    queryId: string;
    origin: string;
    destination: string;
    currency: string | null;
    previousMin: number;
    currentMin: number;
    drop: number;
    airline: string;
  }> = [];

  for (const q of queries) {
    if (q.fetchRuns.length < 2) continue;

    const [latestRun, previousRun] = q.fetchRuns;

    const [currentSnapshots, previousSnapshots] = await Promise.all([
      prisma.priceSnapshot.findMany({
        where: { queryId: q.id, fetchRunId: latestRun!.id },
        select: { price: true, airline: true },
      }),
      prisma.priceSnapshot.findMany({
        where: { queryId: q.id, fetchRunId: previousRun!.id },
        select: { price: true },
      }),
    ]);

    if (currentSnapshots.length === 0 || previousSnapshots.length === 0) continue;

    const currentMin = currentSnapshots.reduce(
      (best, s) => (s.price < best.price ? s : best),
      currentSnapshots[0]!
    );
    const previousMin = Math.min(...previousSnapshots.map((s) => s.price));

    const drop = previousMin - currentMin.price;
    // Only alert on drops of $20+ or 5%+
    if (drop >= 20 || (drop > 0 && drop / previousMin >= 0.05)) {
      alerts.push({
        queryId: q.id,
        origin: q.origin,
        destination: q.destination,
        currency: q.currency,
        previousMin,
        currentMin: currentMin.price,
        drop: Math.round(drop),
        airline: currentMin.airline,
      });
    }
  }

  // Sort by biggest drop first
  alerts.sort((a, b) => b.drop - a.drop);

  return apiSuccess({ alerts });
}
