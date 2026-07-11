import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import {
  getPageViewsOverTime,
  getTopPagesEngagement,
  getTopReferrerDomains,
  getReferrerLandingPages,
  getDeviceBreakdown,
  getBrowserBreakdown,
  getOsBreakdown,
  getRealtimeVisitors,
  getTotalStats,
  getCountryBreakdown,
  getBotStats,
  getHumanStats,
  getEntryPages,
  getExitPages,
  getPagesPerSession,
  getHourlyHeatmap,
} from '@/lib/analytics/query';
import type { BotFilter } from '@/lib/analytics/query';
import { OverviewCards } from './components/OverviewCards';
import { PageViewsChart } from './components/PageViewsChart';
import { TopPagesTable } from './components/TopPagesTable';
import { ReferrersChart } from './components/ReferrersChart';
import { ReferrerLandingTable } from './components/ReferrerLandingTable';
import { DevicesChart } from './components/DevicesChart';
import { BrowsersChart } from './components/BrowsersChart';
import { OsChart } from './components/OsChart';
import { CountryChart } from './components/CountryChart';
import { BotSummary } from './components/BotSummary';
import { BotFilterToggle } from './components/BotFilterToggle';
import { DateRangePicker } from './components/DateRangePicker';
import { RealtimePulse } from './components/RealtimePulse';
import { EntryExitTable } from './components/EntryExitTable';
import { SessionDepthChart } from './components/SessionDepthChart';
import { HourlyHeatmap } from './components/HourlyHeatmap';
import styles from './page.module.css';

interface Props {
  searchParams: Promise<{ from?: string; to?: string; botFilter?: string }>;
}

function parseBotFilter(value: string | undefined): BotFilter {
  if (value === 'bots' || value === 'all') return value;
  return 'humans';
}

export default async function AnalyticsDashboard({ searchParams }: Props) {
  const params = await searchParams;
  const now = new Date();
  const to = params.to || now.toISOString().slice(0, 10);
  const from =
    params.from || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const botFilter = parseBotFilter(params.botFilter);
  const opts = { from, to, botFilter };

  const [
    pageViews,
    topPages,
    referrerDomains,
    referrerLandings,
    devices,
    browsers,
    osData,
    countries,
    realtime,
    totals,
    botStats,
    humanStats,
    entryPages,
    exitPages,
    sessionDepth,
    heatmap,
  ] = [
    getPageViewsOverTime(opts),
    getTopPagesEngagement(opts),
    getTopReferrerDomains(opts),
    getReferrerLandingPages(opts),
    getDeviceBreakdown(opts),
    getBrowserBreakdown(opts),
    getOsBreakdown(opts),
    getCountryBreakdown(opts),
    getRealtimeVisitors(),
    getTotalStats(opts),
    getBotStats({ from, to }),
    getHumanStats({ from, to }),
    getEntryPages(opts),
    getExitPages(opts),
    getPagesPerSession(opts),
    getHourlyHeatmap(opts),
  ];

  const t = await getTranslations('AdminAnalytics');

  return (
    <div className={styles.dashboard}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('title')}</h1>
        <div className={styles.headerActions}>
          <Suspense>
            <BotFilterToggle current={botFilter} />
            <DateRangePicker from={from} to={to} />
          </Suspense>
        </div>
      </header>

      <OverviewCards totals={totals} />
      <PageViewsChart data={pageViews} />

      <div className={styles.splitRow}>
        <TopPagesTable pages={topPages} />
        <ReferrersChart data={referrerDomains} />
      </div>

      <ReferrerLandingTable data={referrerLandings} />
      <EntryExitTable entryPages={entryPages} exitPages={exitPages} />
      <HourlyHeatmap data={heatmap} />

      <div className={styles.splitRow}>
        <CountryChart data={countries} />
        <DevicesChart data={devices} />
      </div>

      <div className={styles.splitRow}>
        <BrowsersChart data={browsers} />
        <OsChart data={osData} />
      </div>

      <div className={styles.splitRow}>
        <SessionDepthChart data={sessionDepth} />
        {botFilter === 'humans' ? (
          <BotSummary mode="humans" stats={humanStats} />
        ) : (
          <BotSummary mode="bots" stats={botStats} />
        )}
      </div>

      <RealtimePulse initial={realtime.activeVisitors} />
    </div>
  );
}
