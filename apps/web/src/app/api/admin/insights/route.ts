import { NextRequest } from 'next/server';
import { apiSuccess } from '@/lib/api-response';
import { cached } from '@/lib/redis';
import { computeInsights } from '@/lib/stats/airline-reliability';
import { requireAdminApi } from '@/lib/admin-guard';

export async function GET(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { searchParams } = new URL(request.url);
  const days = Math.min(Number(searchParams.get('days')) || 30, 90);

  const data = await cached(
    `insights:${days}`,
    () => computeInsights(days),
    300 // 5 min cache
  );

  return apiSuccess(data);
}
