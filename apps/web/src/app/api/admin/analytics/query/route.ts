import { NextRequest } from 'next/server';
import {
  getPageViewsOverTime,
  getTopPages,
  getTopReferrerDomains,
  getReferrerLandingPages,
  getDeviceBreakdown,
  getBrowserBreakdown,
  getRealtimeVisitors,
  getTotalStats,
  getCountryBreakdown,
  getBotStats,
  getHumanStats,
  getOsBreakdown,
  getTopPagesEngagement,
  getEntryPages,
  getExitPages,
  getPagesPerSession,
  getHourlyHeatmap,
} from '@/lib/analytics/query';
import type { BotFilter } from '@/lib/analytics/query';
import { apiSuccess, apiError } from '@/lib/api-response';
import { requireAdminApi } from '@/lib/admin-guard';

function parseBotFilter(value: string | null): BotFilter {
  if (value === 'bots' || value === 'all') return value;
  return 'humans';
}

export async function GET(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { searchParams } = request.nextUrl;
  const metric = searchParams.get('metric');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const botFilter = parseBotFilter(searchParams.get('botFilter'));

  if (!metric) {
    return apiError('Missing metric parameter', 400);
  }

  if (metric === 'realtime') {
    return apiSuccess(getRealtimeVisitors());
  }

  if (!from || !to) {
    return apiError('Missing from/to parameters', 400);
  }

  const opts = { from, to, botFilter };

  switch (metric) {
    case 'pageviews':
      return apiSuccess(getPageViewsOverTime(opts));
    case 'top-pages':
      return apiSuccess(getTopPages(opts));
    case 'referrers':
    case 'referrer-domains':
      return apiSuccess(getTopReferrerDomains(opts));
    case 'referrer-landing-pages':
      return apiSuccess(getReferrerLandingPages(opts));
    case 'devices':
      return apiSuccess(getDeviceBreakdown(opts));
    case 'browsers':
      return apiSuccess(getBrowserBreakdown(opts));
    case 'totals':
      return apiSuccess(getTotalStats(opts));
    case 'countries':
      return apiSuccess(getCountryBreakdown(opts));
    case 'bot-stats':
      return apiSuccess(getBotStats({ from, to }));
    case 'human-stats':
      return apiSuccess(getHumanStats({ from, to }));
    case 'os':
      return apiSuccess(getOsBreakdown(opts));
    case 'top-pages-engagement':
      return apiSuccess(getTopPagesEngagement(opts));
    case 'entry-pages':
      return apiSuccess(getEntryPages(opts));
    case 'exit-pages':
      return apiSuccess(getExitPages(opts));
    case 'pages-per-session':
      return apiSuccess(getPagesPerSession(opts));
    case 'hourly-heatmap':
      return apiSuccess(getHourlyHeatmap(opts));
    default:
      return apiError(`Unknown metric: ${metric}`, 400);
  }
}
