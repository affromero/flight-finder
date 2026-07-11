import { getTranslations } from 'next-intl/server';
import { computeInsights } from '@/lib/stats/airline-reliability';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

const TREND_ARROWS: Record<string, string> = {
  rising: '↑',
  falling: '↓',
  stable: '→',
};

function stabilityKey(cov: number): string {
  if (cov < 0.05) return 'veryStable';
  if (cov < 0.15) return 'stable';
  if (cov < 0.3) return 'moderate';
  return 'volatile';
}

function stabilityClass(cov: number): string {
  if (cov < 0.05) return styles.stabilityGood ?? '';
  if (cov < 0.15) return styles.stabilityOk ?? '';
  if (cov < 0.3) return styles.stabilityWarn ?? '';
  return styles.stabilityBad ?? '';
}

export default async function InsightsPage() {
  const t = await getTranslations('AdminInsights');
  const data = await computeInsights(30);

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.description}>
        {t('description')}
      </p>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{data.totalSeedRoutes}</span>
          <span className={styles.statLabel}>{t('stats.seedRoutes')}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{data.totalSnapshots}</span>
          <span className={styles.statLabel}>{t('stats.pricePoints')}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{data.totalAirlines}</span>
          <span className={styles.statLabel}>{t('stats.airlinesTracked')}</span>
        </div>
      </div>

      {data.routes.length === 0 ? (
        <p className={styles.empty}>
          {t.rich('empty', { link: (chunks) => <a href="/admin/seed-routes">{chunks}</a> })}
        </p>
      ) : (
        data.routes.map((route) => (
          <div key={route.route} className={styles.routeCard}>
            <div className={styles.routeHeader}>
              <div className={styles.routeCodes}>
                <span className={styles.routeCode}>{route.origin}</span>
                <span className={styles.routeArrow}>→</span>
                <span className={styles.routeCode}>{route.destination}</span>
              </div>
              <span className={styles.routeNames}>
                {route.originName} → {route.destinationName}
              </span>
            </div>

            {route.airlines.length === 0 ? (
              <p className={styles.noData}>{t('noData')}</p>
            ) : (
              <>
                <div className={styles.routeSummary}>
                  <span>{t.rich('cheapest', { airline: route.cheapestAirline, strong: (chunks) => <strong>{chunks}</strong> })}</span>
                  <span className={styles.rowSep}>·</span>
                  <span>{t.rich('mostStable', { airline: route.mostStableAirline, strong: (chunks) => <strong>{chunks}</strong> })}</span>
                  <span className={styles.rowSep}>·</span>
                  <span>{t('dataPoints', { count: route.totalSnapshots })}</span>
                </div>

                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t('table.rank')}</th>
                        <th>{t('table.airline')}</th>
                        <th>{t('table.avgPrice')}</th>
                        <th>{t('table.min')}</th>
                        <th>{t('table.max')}</th>
                        <th>{t('table.stability')}</th>
                        <th>{t('table.trend')}</th>
                        <th>{t('table.samples')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {route.airlines.map((a) => (
                        <tr key={a.airline}>
                          <td className={styles.mono}>#{a.competitiveRank}</td>
                          <td className={styles.airlineName}>{a.airline}</td>
                          <td className={styles.mono}>${a.avgPrice}</td>
                          <td className={styles.mono}>${a.minPrice}</td>
                          <td className={styles.mono}>${a.maxPrice}</td>
                          <td>
                            <span className={stabilityClass(a.stability)}>
                              {t(`stability.${stabilityKey(a.stability)}`)}
                            </span>
                          </td>
                          <td className={`${styles.mono} ${a.trend === 'rising' ? styles.trendUp : a.trend === 'falling' ? styles.trendDown : styles.trendFlat}`}>
                            {TREND_ARROWS[a.trend]} {t(`trend.${a.trend}`)}
                          </td>
                          <td className={styles.mono}>{a.snapshotCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        ))
      )}
    </div>
  );
}
