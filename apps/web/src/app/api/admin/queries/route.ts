import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { searchParams } = request.nextUrl;
  const rawLimit = searchParams.get('limit');
  const rawPage = searchParams.get('page');

  const limit = Math.min(
    rawLimit !== null ? parseInt(rawLimit, 10) : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const page = rawPage !== null ? parseInt(rawPage, 10) : 0;

  if (!Number.isFinite(limit) || limit < 1) {
    return apiError('Invalid limit parameter', 400);
  }
  if (!Number.isFinite(page) || page < 0) {
    return apiError('Invalid page parameter', 400);
  }

  const queries = await prisma.query.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: page * limit,
    include: {
      _count: { select: { snapshots: true, fetchRuns: true } },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true, error: true },
      },
    },
  });

  return apiSuccess({ queries, page, limit });
}
