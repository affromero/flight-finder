import { apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';

export async function GET() {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const queries = await prisma.query.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { snapshots: true, fetchRuns: true } },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true, error: true },
      },
    },
  });

  return apiSuccess(queries);
}
