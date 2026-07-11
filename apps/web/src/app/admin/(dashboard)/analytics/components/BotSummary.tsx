import { getTranslations } from 'next-intl/server';
import type { BotStats, HumanStats } from '@/lib/analytics/query';
import styles from './BotSummary.module.css';

interface BotProps {
  mode: 'bots';
  stats: BotStats;
}

interface HumanProps {
  mode: 'humans';
  stats: HumanStats;
}

type Props = BotProps | HumanProps;

export async function BotSummary(props: Props) {
  const t = await getTranslations('AdminAnalytics');
  if (props.mode === 'humans') {
    const { stats } = props;
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>{t('botSummary.visitorQuality')}</h2>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('botSummary.totalHuman')}</span>
            <span className={styles.statValue}>{stats.total.toLocaleString()}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('botSummary.confirmedJs')}</span>
            <span className={styles.statValue}>{stats.confirmedHumans.toLocaleString()}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('botSummary.presumed')}</span>
            <span className={styles.statValue}>{stats.presumedHumans.toLocaleString()}</span>
          </div>
        </div>
        <p className={styles.hint}>
          {t('botSummary.humanHint')}
        </p>
      </div>
    );
  }

  const { stats } = props;
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('botSummary.botActivity')}</h2>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('botSummary.totalBotHits')}</span>
          <span className={styles.statValue}>{stats.totalBotHits.toLocaleString()}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('botSummary.knownBots')}</span>
          <span className={styles.statValue}>{stats.knownBots.toLocaleString()}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('botSummary.suspectedBots')}</span>
          <span className={styles.statValue}>{stats.suspectedBots.toLocaleString()}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{t('botSummary.uniqueBots')}</span>
          <span className={styles.statValue}>{stats.uniqueBots.toLocaleString()}</span>
        </div>
      </div>
      {stats.topBots.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('botSummary.bot')}</th>
              <th>{t('botSummary.hits')}</th>
            </tr>
          </thead>
          <tbody>
            {stats.topBots.map((bot) => (
              <tr key={bot.name}>
                <td>{bot.name}</td>
                <td>{bot.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stats.topBots.length === 0 && (
        <p className={styles.empty}>{t('botSummary.empty')}</p>
      )}
    </div>
  );
}
