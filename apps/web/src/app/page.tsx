import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import styles from './page.module.css';
import { SearchBar } from '@/components/SearchBar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SavedTrackers } from '@/components/SavedTrackers';
import { SetupRedirect } from '@/components/SetupRedirect';
import { UsageStats } from '@/components/UsageStats';
import { PriceAlerts } from '@/components/PriceAlerts';
import { UpdateBanner } from '@/components/UpdateBanner';
import { Footer } from '@/components/Footer';
import { DemoGif } from '@/components/DemoGif';
import { InstallCommand } from '@/components/InstallCommand';
import { ProfileMenu } from '@/components/ProfileMenu/ProfileMenu';
import { verifyAdminSessionRevocable } from '@/lib/admin-guard';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { safeJsonLd } from '@/app/q/[id]/safe-json-ld';

// Force dynamic — isMultiUserEnabled + getCurrentUser run per request to
// decide between the public landing, the multi user login redirect, and
// the welcome line for an authenticated household member.
export const dynamic = 'force-dynamic';

const isSelfHosted = process.env.SELF_HOSTED === 'true';

export default async function HomePage() {
  const t = await getTranslations('Landing');
  const multiUserEnabled = await isMultiUserEnabled();
  const user = multiUserEnabled ? await getCurrentUser() : null;

  // Self-hosted multi user mode requires a logged in user even for the landing page.
  // The household setting means there's no public surface to share with strangers.
  if (multiUserEnabled && !user) {
    redirect('/login?next=/');
  }

  const isAdmin = multiUserEnabled
    ? Boolean(user?.isAdmin)
    : await verifyAdminSessionRevocable();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Flight Finder',
    url: 'https://flight-finder.org',
    description:
      'Track flight prices over time with shareable charts. See how fares evolve, compare airlines, and book at the right moment.',
    applicationCategory: 'TravelApplication',
    operatingSystem: 'Any',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };

  return (
    <main className={styles.root}>
      {isSelfHosted && <SetupRedirect />}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <div className={styles.topBar}>
        {!(multiUserEnabled && user) &&
          (isSelfHosted ? (
            <Link href="/settings" className={styles.adminLink} title={t('settings')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6.5 1.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v.3a5.5 5.5 0 0 1 1.654.685l.212-.212a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1 0 1.061l-.212.212A5.5 5.5 0 0 1 14 6.5h.25a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75H14a5.5 5.5 0 0 1-.685 1.654l.212.212a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061 0l-.212-.212A5.5 5.5 0 0 1 9.5 14v.25a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75V14a5.5 5.5 0 0 1-1.654-.685l-.212.212a.75.75 0 0 1-1.06 0l-1.061-1.06a.75.75 0 0 1 0-1.061l.212-.212A5.5 5.5 0 0 1 2 9.5h-.25a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75H2a5.5 5.5 0 0 1 .685-1.654l-.212-.212a.75.75 0 0 1 0-1.06l1.06-1.061a.75.75 0 0 1 1.061 0l.212.212A5.5 5.5 0 0 1 6.5 2.05v-.3ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
                  fill="currentColor"
                />
              </svg>
            </Link>
          ) : (
            isAdmin && (
              <Link href="/admin" className={styles.adminLink} title={t('adminPanel')}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 1.5a1.25 1.25 0 0 1 1.177.824l.963 2.681 2.825.213a1.25 1.25 0 0 1 .712 2.19l-2.142 1.818.658 2.77a1.25 1.25 0 0 1-1.863 1.354L8 11.885 5.67 13.35a1.25 1.25 0 0 1-1.863-1.354l.658-2.77-2.142-1.818a1.25 1.25 0 0 1 .712-2.19l2.825-.213.963-2.681A1.25 1.25 0 0 1 8 1.5Z"
                    fill="currentColor"
                  />
                </svg>
              </Link>
            )
          ))}
        <ThemeToggle />
        {multiUserEnabled && user && (
          <ProfileMenu
            user={{
              username: user.username,
              displayName: user.displayName,
              avatar: user.avatar,
              isAdmin: user.isAdmin,
            }}
          />
        )}
      </div>
      <div className={styles.hero}>
        <h1 className={styles.title}><Link href="/">Flight Finder</Link></h1>
        <p className={styles.tagline}>
          {t('tagline')}
        </p>
        {!isSelfHosted && (
          <a href="https://github.com/affromero/flight-finder" target="_blank" rel="noopener noreferrer" className={styles.githubLink}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            {t('viewOnGithub')}
          </a>
        )}
        {isSelfHosted ? (
          <>
            <SearchBar />
            <UpdateBanner />
            <PriceAlerts />
            <SavedTrackers isAuthenticated={multiUserEnabled && !!user} />
            <UsageStats />
          </>
        ) : (
          <>
            <InstallCommand />
            <div className={styles.providers}>
              <h2 className={styles.providersTitle}>{t('byoLlmTitle')}</h2>
              <div className={styles.providerGrid}>
                <div className={`${styles.providerCard} ${styles.providerFree}`}>
                  <span className={styles.providerName}>Claude Code</span>
                  <span className={styles.providerTag}>{t('tagFreeWithMax')}</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerFree}`}>
                  <span className={styles.providerName}>Codex CLI</span>
                  <span className={styles.providerTag}>{t('tagFreeWithPro')}</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerLocal}`}>
                  <span className={styles.providerName}>Ollama</span>
                  <span className={styles.providerTag}>{t('tagLocal')}</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerLocal}`}>
                  <span className={styles.providerName}>llama.cpp</span>
                  <span className={styles.providerTag}>{t('tagLocal')}</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerLocal}`}>
                  <span className={styles.providerName}>vLLM</span>
                  <span className={styles.providerTag}>{t('tagLocalGpu')}</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Anthropic</span>
                  <span className={styles.providerTag}>{t('tagApiKey')}</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>OpenAI</span>
                  <span className={styles.providerTag}>{t('tagApiKey')}</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Google AI</span>
                  <span className={styles.providerTag}>{t('tagApiKey')}</span>
                </div>
              </div>
              <p className={styles.providersHint}>
                {t('byoLlmHint')}
              </p>
            </div>

            <div className={styles.providers}>
              <h2 className={styles.providersTitle}>{t('vpnTitle')}</h2>
              <div className={styles.vpnGrid}>
                <div className={`${styles.providerCard} ${styles.providerFree}`}>
                  <span className={styles.providerName}>ExpressVPN</span>
                  <span className={styles.providerTag}>{t('tagSupported')}</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>NordVPN</span>
                  <span className={styles.providerTag}>{t('tagComingSoon')}</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Mullvad</span>
                  <span className={styles.providerTag}>{t('tagComingSoon')}</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>{t('customProxy')}</span>
                  <span className={styles.providerTag}>{t('tagComingSoon')}</span>
                </div>
              </div>
              <p className={styles.providersHint}>
                {t('vpnHint')}
              </p>
              <details className={styles.stealthDetails}>
                <summary className={styles.stealthSummary}>{t('stealthSummary')}</summary>
                <ul className={styles.stealthList}>
                  <li>{t('stealthTimezone')}</li>
                  <li>{t('stealthGeolocation')}</li>
                  <li>{t('stealthWebrtc')}</li>
                  <li>{t('stealthDns')}</li>
                  <li>{t('stealthFingerprints')}</li>
                  <li>{t('stealthScreen')}</li>
                  <li>{t('stealthExitCountry')}</li>
                </ul>
              </details>
            </div>
          </>
        )}
      </div>

      {!isSelfHosted && (
        <div className={styles.demo}>
          <DemoGif />
        </div>
      )}

      <section className={styles.why}>
        <h2 className={styles.whyTitle}>{t('whyTitle')}</h2>
        <div className={styles.reasons}>
          <div className={styles.reason}>
            <span className={styles.reasonNumber}>1</span>
            <div>
              <h3 className={styles.reasonTitle}>{t('reason1Title')}</h3>
              <p className={styles.reasonText}>
                {t('reason1Text')}
              </p>
            </div>
          </div>
          <div className={styles.reason}>
            <span className={styles.reasonNumber}>2</span>
            <div>
              <h3 className={styles.reasonTitle}>{t('reason2Title')}</h3>
              <p className={styles.reasonText}>
                {t('reason2Text')}
              </p>
            </div>
          </div>
          <div className={styles.reason}>
            <span className={styles.reasonNumber}>3</span>
            <div>
              <h3 className={styles.reasonTitle}>{t('reason3Title')}</h3>
              <p className={styles.reasonText}>
                {t('reason3Text')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {!isSelfHosted && (
        <section className={styles.how}>
          <h2 className={styles.whyTitle}>{t('howTitle')}</h2>
          <div className={styles.steps}>
            <div className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <div>
                <h3 className={styles.reasonTitle}>{t('how1Title')}</h3>
                <p className={styles.reasonText}>
                  {t('how1Text')}
                </p>
              </div>
            </div>
            <div className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <div>
                <h3 className={styles.reasonTitle}>{t('how2Title')}</h3>
                <p className={styles.reasonText}>
                  {t('how2Text')}
                </p>
              </div>
            </div>
            <div className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <div>
                <h3 className={styles.reasonTitle}>{t('how3Title')}</h3>
                <p className={styles.reasonText}>
                  {t('how3Text')}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!isSelfHosted && (
        <section className={styles.notSection}>
          <h2 className={styles.whyTitle}>{t('notTitle')}</h2>
          <div className={styles.notItems}>
            <div className={styles.notItem}>
              <span className={styles.notIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('notAggregatorTitle')}</h3>
                <p className={styles.reasonText}>
                  {t('notAggregatorText')}
                </p>
              </div>
            </div>
            <div className={styles.notItem}>
              <span className={styles.notIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('notAiTitle')}</h3>
                <p className={styles.reasonText}>
                  {t('notAiText')}
                </p>
              </div>
            </div>
            <div className={styles.notItem}>
              <span className={styles.notIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('notPredictorTitle')}</h3>
                <p className={styles.reasonText}>
                  {t('notPredictorText')}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!isSelfHosted && (
        <section className={styles.selfHost}>
          <h2 className={styles.whyTitle}>{t('selfHostTitle')}</h2>
          <p className={styles.selfHostLead}>
            {t('selfHostLead')}
          </p>
          <div className={styles.benefits}>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('benefit1Title')}</h3>
                <p className={styles.reasonText}>
                  {t('benefit1Text')}
                </p>
              </div>
            </div>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('benefit2Title')}</h3>
                <p className={styles.reasonText}>
                  {t('benefit2Text')}
                </p>
              </div>
            </div>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('benefit3Title')}</h3>
                <p className={styles.reasonText}>
                  {t('benefit3Text')}
                </p>
              </div>
            </div>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>{t('benefit4Title')}</h3>
                <p className={styles.reasonText}>
                  {t('benefit4Text')}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      <Footer />
    </main>
  );
}
