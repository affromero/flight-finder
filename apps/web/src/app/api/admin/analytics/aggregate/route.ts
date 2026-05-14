import { NextRequest } from 'next/server';
import { aggregateDay, cleanupOldEvents, cleanupOldSalts } from '@/lib/analytics/aggregate';
import { apiSuccess } from '@/lib/api-response';
import { requireAdminApi } from '@/lib/admin-guard';

export async function POST(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { searchParams } = request.nextUrl;
  const date = searchParams.get('date') || undefined;

  const { aggregated, eventsProcessed, suspectedBots } = aggregateDay(date);
  const deletedEvents = cleanupOldEvents();
  const deletedSalts = cleanupOldSalts();

  return apiSuccess({
    aggregation: { aggregated, eventsProcessed, suspectedBots },
    cleanup: { deletedEvents, deletedSalts },
  });
}
