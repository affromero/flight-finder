import { apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';

const isSelfHosted = process.env.SELF_HOSTED === 'true';

export async function GET() {
  const multiUser = await isMultiUserEnabled();

  // In multi user mode, only return the current user's queries. Admins still
  // get every tracker via /api/admin/queries; this endpoint powers the per
  // user landing page list.
  let userFilter: { userId: string } | null = null;
  if (multiUser) {
    const user = await getCurrentUser();
    if (!user) return apiSuccess({ queries: [] });
    userFilter = { userId: user.id };
  }

  // Self-hosted: include paused queries too so users can resume them
  const queries = await prisma.query.findMany({
    where: {
      isSeed: false,
      ...(isSelfHosted ? {} : { active: true }),
      ...(userFilter ?? {}),
      OR: [{ expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      active: true,
      origin: true,
      destination: true,
      originName: true,
      destinationName: true,
      dateFrom: true,
      dateTo: true,
      scrapeInterval: true,
      createdAt: true,
      expiresAt: true,
      groupId: true,
      label: true,
      preferredAggregators: true,
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true, error: true },
      },
      _count: {
        select: { snapshots: true },
      },
    },
  });

  const result = queries.map((q) => ({
    id: q.id,
    active: q.active,
    origin: q.origin,
    destination: q.destination,
    originName: q.originName,
    destinationName: q.destinationName,
    dateFrom: q.dateFrom.toISOString().split('T')[0],
    dateTo: q.dateTo.toISOString().split('T')[0],
    scrapeInterval: q.scrapeInterval,
    snapshotCount: q._count.snapshots,
    lastScrapedAt: q.fetchRuns[0]?.startedAt.toISOString() ?? null,
    lastScrapeStatus: q.fetchRuns[0]?.status ?? null,
    lastScrapeError: q.fetchRuns[0]?.error ?? null,
    groupId: q.groupId,
    label: q.label,
    preferredAggregators: q.preferredAggregators,
    createdAt: q.createdAt.toISOString(),
  }));

  return apiSuccess({ queries: result });
}
