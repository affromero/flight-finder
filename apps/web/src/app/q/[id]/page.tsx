import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/prisma';
import { ACTUAL_FLIGHT_FARE_WHERE, latestFlightObservations, flightComparisonCurrency, lowestFlightFare, availableFlightFares } from '@/lib/flight-pricing';
import { PriceChart } from '@/components/PriceChart';
import { BestPrice } from '@/components/BestPrice';
import { PriceHistory } from '@/components/PriceHistory';
import Link from 'next/link';
import { ThemeToggle } from '@/components/ThemeToggle';
import { DeleteTracker } from '@/components/DeleteTracker';
import { ScrapeInterval } from '@/components/ScrapeInterval';
import { AggregatorPicker } from '@/components/AggregatorPicker';
import { TrackerLabel } from '@/components/TrackerLabel';
import { ChartActions } from '@/components/ChartActions';
import { PriceCalendar } from '@/components/PriceCalendar';
import { Footer } from '@/components/Footer';
import { StackedSortControls, type StackedItem } from '@/components/StackedSortControls';
import { ScrapeStatusDot } from '@/components/ScrapeStatusDot';
import { ForceScrapeButton } from '@/components/ForceScrapeButton';
import { TrackerFilters } from '@/components/TrackerFilters';
import { TrackerNotifications } from '@/components/notifications/TrackerNotifications';
import { TrackerPriceRules } from '@/components/notifications/TrackerPriceRules';
import { aggregateScrapeStatus } from '@/lib/scrape-status';
import { canManageQueryWithoutToken } from '@/lib/query-auth';
import { filterSnapshotsByTrackerFilters } from '@/lib/snapshot-filters';
import { MAX_TRACKER_EDIT_EVENTS } from '@/lib/tracker-edit-events';
import { groupDateRange } from './group-date-range';
import { safeJsonLd } from './safe-json-ld';
import styles from './page.module.css';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const query = await prisma.query.findUnique({ where: { id } });

  if (!query) return {};

  // When the row is part of a flex group, every sibling stores a single
  // pinned date, so the row's own dateFrom/dateTo span only one day. Fetch
  // the siblings to surface the real travel window on the share card.
  let dateFrom = query.dateFrom;
  let dateTo = query.dateTo;
  if (query.groupId) {
    const siblings = await prisma.query.findMany({
      where: { groupId: query.groupId },
      select: { dateFrom: true, dateTo: true },
    });
    if (siblings.length > 0) {
      ({ dateFrom, dateTo } = groupDateRange(siblings));
    }
  }

  const title = `${query.originName} to ${query.destinationName} Flight Prices`;
  const dateRange = `${formatDate(dateFrom)} - ${formatDate(dateTo)}`;
  const description = `Track ${query.origin} → ${query.destination} flight prices (${dateRange}). See price history, compare airlines, and book at the right moment.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
    },
  };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(d: Date): number {
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

interface ChartSnapshot {
  id: string;
  travelDate: string;
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  duration: string | null;
  layovers?: unknown;
  flightId: string | null;
  flightNumber: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  seatsLeft: number | null;
  status: string;
  airlineDirectPrice: number | null;
  vpnCountry: string | null;
  scrapedAt: string;
}

interface QueryWithSnapshots {
  query: {
    id: string;
    rawInput: string;
    origin: string;
    originName: string;
    destination: string;
    destinationName: string;
    dateFrom: Date;
    dateTo: Date;
    flexibility: number;
    tripType: string;
    active: boolean;
    maxPrice: number | null;
    maxStops: number | null;
    maxDurationHours: number | null;
    preferredAirlines: string[];
    timePreference: string;
    strictDepartureTime: boolean;
    cabinClass: string;
    expiresAt: Date;
    createdAt: Date;
    firstViewedAt: Date | null;
    groupId: string | null;
    currency: string | null;
    scrapeInterval: number | null;
    vpnCountries: string[];
    preferredAggregators: string[];
    label: string | null;
    userId: string | null;
  };
  snapshots: ChartSnapshot[];
  allSnapshots: ChartSnapshot[];
  editEvents: Array<{
    id: string;
    editedAt: string;
    summary: string;
  }>;
  lastRun: { startedAt: Date; status: string; error: string | null } | null;
  globalScrapeInterval: number;
  canEdit: boolean;
}

type Translator = Awaited<ReturnType<typeof getTranslations>>;

function renderRouteBlock(qData: QueryWithSnapshots, isMultiRoute: boolean, t: Translator, comparisonCurrency: string | null) {
  const isRoundTrip = qData.query.tripType === 'round_trip';
  const hasDistinctReturn = qData.query.dateFrom.getTime() < qData.query.dateTo.getTime();
  const dateLabel = isRoundTrip && hasDistinctReturn
    ? `${formatDate(qData.query.dateFrom)} → ${formatDate(qData.query.dateTo)}`
    : formatDate(qData.query.dateFrom);
  const currentSnapshots = filterSnapshotsByTrackerFilters(
    availableFlightFares(latestFlightObservations(qData.allSnapshots, qData.query), comparisonCurrency), qData.query,
  );

  return (
    <section key={qData.query.id} className={styles.routeBlock} aria-label={`${t('routeName', { origin: qData.query.originName, destination: qData.query.destinationName })} ${dateLabel}`}>
      {isMultiRoute && (
        <div className={styles.routeBlockHeader}>
          <span className={styles.routeBlockCode}>{qData.query.origin}</span>
          <span className={styles.routeBlockArrow}>→</span>
          <span className={styles.routeBlockCode}>{qData.query.destination}</span>
          <span className={styles.routeBlockName}>
            {t('routeName', { origin: qData.query.originName, destination: qData.query.destinationName })}
          </span>
          <span className={styles.routeBlockDate}>{dateLabel}</span>
        </div>
      )}

      <TrackerNotifications queryId={qData.query.id} canEdit={qData.canEdit} />
      <TrackerPriceRules queryId={qData.query.id} canEdit={qData.canEdit} />
      <section className={styles.chart}>
        <PriceChart
          trackerId={qData.query.id}
          snapshots={qData.snapshots}
          allSnapshots={qData.allSnapshots}
          editEvents={qData.editEvents}
          currency={qData.query.currency ?? 'USD'}
        />
        {qData.query.vpnCountries.length > 0 && !qData.allSnapshots.some((s) => s.vpnCountry) && (
          <p className={styles.vpnPending}>
            {t('vpnPending', {
              countries: qData.query.vpnCountries.map((c) =>
                String.fromCodePoint(...c.split('').map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) + ' ' + c
              ).join(', '),
            })}
          </p>
        )}
      </section>

      <section className={styles.best}>
        <BestPrice snapshots={qData.allSnapshots} currency={comparisonCurrency} filters={qData.query} route={qData.query} />
      </section>

      <section className={styles.history}>
        <PriceHistory snapshots={qData.snapshots} trackerId={qData.query.id} />
      </section>

      <section className={styles.calendar}>
        <PriceCalendar snapshots={currentSnapshots} currency={comparisonCurrency ?? 'USD'} />
      </section>
    </section>
  );
}

function currentPriceForSibling(qData: QueryWithSnapshots, currency: string | null): number | null {
  const latest = latestFlightObservations(qData.allSnapshots, qData.query);
  return lowestFlightFare(filterSnapshotsByTrackerFilters(latest, qData.query), currency)?.price ?? null;
}

function buildStackedItem(qData: QueryWithSnapshots, t: Translator, currency: string | null): StackedItem {
  return {
    key: qData.query.id,
    outboundDate: qData.query.dateFrom.toISOString().slice(0, 10),
    currentPrice: currentPriceForSibling(qData, currency),
    node: renderRouteBlock(qData, true, t, currency),
  };
}

async function loadQueryWithSnapshots(id: string): Promise<QueryWithSnapshots | null> {
  const query = await prisma.query.findUnique({ where: { id } });
  if (!query) return null;

  const snapshots = await prisma.priceSnapshot.findMany({
    where: { queryId: id, ...ACTUAL_FLIGHT_FARE_WHERE },
    orderBy: { scrapedAt: 'asc' },
    select: {
      id: true,
      travelDate: true,
      price: true,
      currency: true,
      airline: true,
      bookingUrl: true,
      stops: true,
      duration: true,
      layovers: true,
      flightId: true,
      flightNumber: true,
      departureTime: true,
      arrivalTime: true,
      seatsLeft: true,
      status: true,
      airlineDirectPrice: true,
      vpnCountry: true,
      scrapedAt: true,
    },
  });

  const lastRun = await prisma.fetchRun.findFirst({
    where: { queryId: id },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true, status: true, error: true },
  });

  const globalConfig = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { scrapeInterval: true },
  });

  const editEventsDesc = await prisma.queryEditEvent.findMany({
    where: { queryId: id },
    orderBy: { editedAt: 'desc' },
    take: MAX_TRACKER_EDIT_EVENTS,
    select: {
      id: true,
      editedAt: true,
      summary: true,
    },
  });

  const allSnapshots = snapshots.map((s) => ({
    ...s,
    travelDate: s.travelDate.toISOString(),
    scrapedAt: s.scrapedAt.toISOString(),
  }));

  return {
    query,
    snapshots: filterSnapshotsByTrackerFilters(allSnapshots, query),
    allSnapshots,
    editEvents: editEventsDesc.slice().reverse().map((event) => ({
      id: event.id,
      editedAt: event.editedAt.toISOString(),
      summary: event.summary,
    })),
    lastRun,
    globalScrapeInterval: globalConfig?.scrapeInterval ?? 3,
    canEdit: await canManageQueryWithoutToken(query),
  };
}

export default async function ChartPage({ params }: Props) {
  const { id } = await params;
  const t = await getTranslations('QueryPage');

  const [primary, adminConfig] = await Promise.all([
    loadQueryWithSnapshots(id),
    prisma.extractionConfig.findFirst({
      where: { id: 'singleton' },
      select: { aggregatorsEnabled: true },
    }),
  ]);
  if (!primary) notFound();

  const adminEnabledAggregators = adminConfig?.aggregatorsEnabled ?? ['google_flights', 'airline_direct'];

  // Whether to surface the per-tracker edit controls when this browser has no
  // saved delete token (e.g. after a machine migration). The backend already
  // authorizes solo/admin/owner mutations tokenless; this keeps the UI in step.
  const canEdit = await canManageQueryWithoutToken(primary.query);

  // Mark first view for 24h auto-cleanup
  if (!primary.query.firstViewedAt) {
    await prisma.query.update({
      where: { id },
      data: { firstViewedAt: new Date() },
    });
  }

  // Fetch sibling queries if this is part of a group
  const allQueries: QueryWithSnapshots[] = [primary];

  if (primary.query.groupId) {
    const siblings = await prisma.query.findMany({
      where: {
        groupId: primary.query.groupId,
        id: { not: id },
      },
      select: { id: true },
    });

    for (const sibling of siblings) {
      const data = await loadQueryWithSnapshots(sibling.id);
      if (data) {
        // Mark sibling first view too
        if (!data.query.firstViewedAt) {
          await prisma.query.update({
            where: { id: sibling.id },
            data: { firstViewedAt: new Date() },
          });
        }
        allQueries.push(data);
      }
    }
  }

  const isMultiRoute = allQueries.length > 1;
  const comparisonCurrency = flightComparisonCurrency(
    allQueries.flatMap(data => latestFlightObservations(data.allSnapshots, data.query)), primary.query.currency,
  ) ?? flightComparisonCurrency(allQueries.flatMap(data => data.allSnapshots), primary.query.currency);
  // Expiry and the page-level date bubble both span the whole group. Each
  // sibling in a flex group stores a single pinned date (dateFrom == dateTo),
  // so reading the primary alone would show "Nov 7 - Nov 7" for a window
  // that actually runs Nov 7 to Nov 11.
  const now = Date.now();
  const groupExpiresAt = allQueries.reduce<Date>(
    (max, q) => (q.query.expiresAt.getTime() > max.getTime() ? q.query.expiresAt : max),
    primary.query.expiresAt,
  );
  const { dateFrom: groupDateFrom, dateTo: groupDateTo } = groupDateRange(
    allQueries.map((q) => q.query),
  );
  const expired = allQueries.every((q) => now > q.query.expiresAt.getTime());
  const daysLeft = daysUntil(groupExpiresAt);
  const scrapeAggregate = aggregateScrapeStatus(
    allQueries.map((q) => ({
      status: q.lastRun?.status ?? null,
      error: q.lastRun?.error ?? null,
      startedAt: q.lastRun?.startedAt.toISOString() ?? null,
    })),
  );

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        name: `${primary.query.originName} to ${primary.query.destinationName} Flight Prices`,
        description: `Flight price tracker for ${primary.query.origin} → ${primary.query.destination}`,
        url: `https://flight-finder.org/q/${id}`,
        isPartOf: { '@type': 'WebSite', name: 'Flight Finder', url: 'https://flight-finder.org' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://flight-finder.org' },
          { '@type': 'ListItem', position: 2, name: `${primary.query.origin} → ${primary.query.destination}`, item: `https://flight-finder.org/q/${id}` },
        ],
      },
    ],
  };

  return (
    <main className={styles.root}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <nav className={styles.topBar}>
        <Link href="/" className={styles.brand}>Flight Finder</Link>
        <ThemeToggle />
      </nav>

      <header className={styles.header}>
        {isMultiRoute ? (
          <>
            <div className={styles.meta}>
              <span>{primary.query.rawInput}</span>
            </div>
            <div className={styles.meta}>
              <span>{formatDate(groupDateFrom)} — {formatDate(groupDateTo)}</span>
              {primary.query.flexibility > 0 && (
                <>
                  <span className={styles.sep}>·</span>
                  <span>{t('flexDays', { days: primary.query.flexibility })}</span>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className={styles.route}>
              <span className={styles.code}>{primary.query.origin}</span>
              <span className={styles.arrow}>→</span>
              <span className={styles.code}>{primary.query.destination}</span>
            </div>
            <div className={styles.meta}>
              <span>{t('routeName', { origin: primary.query.originName, destination: primary.query.destinationName })}</span>
              <span className={styles.sep}>·</span>
              <span>{formatDate(groupDateFrom)} — {formatDate(groupDateTo)}</span>
              {primary.query.flexibility > 0 && (
                <>
                  <span className={styles.sep}>·</span>
                  <span>{t('flexDays', { days: primary.query.flexibility })}</span>
                </>
              )}
            </div>
          </>
        )}
        <TrackerLabel queryId={id} currentLabel={primary.query.label} canEdit={canEdit} />
        <div className={styles.headerActions}>
          <div className={styles.expiry}>
            {expired ? (
              <span className={styles.expiredBadge}>{t('expired')}</span>
            ) : (
              <span className={styles.activeBadge}>{t('expiresIn', { days: daysLeft })}</span>
            )}
          </div>
          <ChartActions
            queryId={id}
            origin={primary.query.origin}
            destination={primary.query.destination}
            snapshots={primary.snapshots}
          />
        </div>
      </header>

      <div className={styles.topControls}>
        <div className={styles.topControlsRow}>
          <p className={styles.topControlsText}>
            <ScrapeStatusDot
              status={scrapeAggregate.status}
              error={scrapeAggregate.error}
              lastScrapedAt={scrapeAggregate.startedAt}
            />
            {t('trackedSince', { date: formatDate(primary.query.createdAt) })}
            {allQueries[0]?.lastRun && ` · ${t('lastChecked', { timeAgo: timeAgo(allQueries[0].lastRun.startedAt, t) })}`}
            {allQueries[0]?.lastRun && !expired && ` · ${t('nextCheck', { hours: primary.query.scrapeInterval ?? primary.globalScrapeInterval })}`}
            {primary.query.scrapeInterval === null && !expired && ` ${t('followsGlobal')}`}
          </p>
          {!expired && (
            <>
              {primary.query.active && (
                <ForceScrapeButton queryId={id} ariaLabel={t('refreshNow')} />
              )}
              <ScrapeInterval queryId={id} currentInterval={primary.query.scrapeInterval} canEdit={canEdit} />
              <TrackerFilters
                queryId={id}
                filters={{
                  maxPrice: primary.query.maxPrice,
                  maxStops: primary.query.maxStops,
                  maxDurationHours: primary.query.maxDurationHours,
                  preferredAirlines: primary.query.preferredAirlines,
                  timePreference: primary.query.timePreference,
                  strictDepartureTime: primary.query.strictDepartureTime,
                }}
                canEdit={canEdit}
              />
              <AggregatorPicker
                queryId={id}
                currentAggregators={primary.query.preferredAggregators}
                adminEnabledAggregators={adminEnabledAggregators}
                canEdit={canEdit}
              />
              <DeleteTracker queryId={id} />
            </>
          )}
        </div>
      </div>

      {expired ? (
        <div className={styles.expiredNotice}>
          <p>{t('expiredOn', { date: formatDate(groupExpiresAt) })}</p>
          <p>{t('expiredSnapshot')}</p>
        </div>
      ) : null}

      {isMultiRoute ? (
        <StackedSortControls items={allQueries.map((q) => buildStackedItem(q, t, comparisonCurrency))} />
      ) : (
        renderRouteBlock(primary, false, t, comparisonCurrency)
      )}

      <Footer />
    </main>
  );
}

function timeAgo(date: Date, t: Translator): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t('justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { hours });
  const days = Math.floor(hours / 24);
  return t('daysAgo', { days });
}
