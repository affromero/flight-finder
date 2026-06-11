import Link from 'next/link';
import { redirect } from 'next/navigation';
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
            <Link href="/settings" className={styles.adminLink} title="Settings">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6.5 1.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v.3a5.5 5.5 0 0 1 1.654.685l.212-.212a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1 0 1.061l-.212.212A5.5 5.5 0 0 1 14 6.5h.25a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75H14a5.5 5.5 0 0 1-.685 1.654l.212.212a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061 0l-.212-.212A5.5 5.5 0 0 1 9.5 14v.25a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75V14a5.5 5.5 0 0 1-1.654-.685l-.212.212a.75.75 0 0 1-1.06 0l-1.061-1.06a.75.75 0 0 1 0-1.061l.212-.212A5.5 5.5 0 0 1 2 9.5h-.25a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75H2a5.5 5.5 0 0 1 .685-1.654l-.212-.212a.75.75 0 0 1 0-1.06l1.06-1.061a.75.75 0 0 1 1.061 0l.212.212A5.5 5.5 0 0 1 6.5 2.05v-.3ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
                  fill="currentColor"
                />
              </svg>
            </Link>
          ) : (
            isAdmin && (
              <Link href="/admin" className={styles.adminLink} title="Admin Panel">
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
          The price trail airlines don&apos;t show you
        </p>
        {!isSelfHosted && (
          <a href="https://github.com/affromero/flight-finder" target="_blank" rel="noopener noreferrer" className={styles.githubLink}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            View on GitHub
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
              <h2 className={styles.providersTitle}>Bring your own LLM</h2>
              <div className={styles.providerGrid}>
                <div className={`${styles.providerCard} ${styles.providerFree}`}>
                  <span className={styles.providerName}>Claude Code</span>
                  <span className={styles.providerTag}>Free with Max</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerFree}`}>
                  <span className={styles.providerName}>Codex CLI</span>
                  <span className={styles.providerTag}>Free with Pro</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerLocal}`}>
                  <span className={styles.providerName}>Ollama</span>
                  <span className={styles.providerTag}>Local</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerLocal}`}>
                  <span className={styles.providerName}>llama.cpp</span>
                  <span className={styles.providerTag}>Local</span>
                </div>
                <div className={`${styles.providerCard} ${styles.providerLocal}`}>
                  <span className={styles.providerName}>vLLM</span>
                  <span className={styles.providerTag}>Local GPU</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Anthropic</span>
                  <span className={styles.providerTag}>API key</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>OpenAI</span>
                  <span className={styles.providerTag}>API key</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Google AI</span>
                  <span className={styles.providerTag}>API key</span>
                </div>
              </div>
              <p className={styles.providersHint}>
                Auto-detected during install. Zero config for CLI subscriptions.
              </p>
            </div>

            <div className={styles.providers}>
              <h2 className={styles.providersTitle}>VPN Price Comparison</h2>
              <div className={styles.vpnGrid}>
                <div className={`${styles.providerCard} ${styles.providerFree}`}>
                  <span className={styles.providerName}>ExpressVPN</span>
                  <span className={styles.providerTag}>Supported</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>NordVPN</span>
                  <span className={styles.providerTag}>Coming soon</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Mullvad</span>
                  <span className={styles.providerTag}>Coming soon</span>
                </div>
                <div className={styles.providerCard}>
                  <span className={styles.providerName}>Custom Proxy</span>
                  <span className={styles.providerTag}>Coming soon</span>
                </div>
              </div>
              <p className={styles.providersHint}>
                Test the myth: do flight prices change when you browse from different countries?
              </p>
              <details className={styles.stealthDetails}>
                <summary className={styles.stealthSummary}>What Flight Finder does beyond switching your IP</summary>
                <ul className={styles.stealthList}>
                  <li>Timezone, locale, and Accept-Language aligned to the target country</li>
                  <li>Geolocation API returns matching coordinates</li>
                  <li>WebRTC leak prevention (real IP never exposed via ICE candidates)</li>
                  <li>DNS queries routed through the VPN tunnel</li>
                  <li>Canvas, WebGL, and AudioContext fingerprints randomized per session</li>
                  <li>Screen dimensions matched to reported viewport</li>
                  <li>Exit country verified via IP geolocation after each connect</li>
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
        <h2 className={styles.whyTitle}>Why can&apos;t you see this data anywhere else?</h2>
        <div className={styles.reasons}>
          <div className={styles.reason}>
            <span className={styles.reasonNumber}>1</span>
            <div>
              <h3 className={styles.reasonTitle}>Aggregators want you inside their app</h3>
              <p className={styles.reasonText}>
                Google Flights, Hopper, and Kayak track price history internally &mdash;
                but lock the charts behind your account. A shareable link sends users
                to a page that isn&apos;t theirs.
              </p>
            </div>
          </div>
          <div className={styles.reason}>
            <span className={styles.reasonNumber}>2</span>
            <div>
              <h3 className={styles.reasonTitle}>&ldquo;Buy or Wait&rdquo; is more profitable than transparency</h3>
              <p className={styles.reasonText}>
                A black-box prediction keeps you dependent on their platform.
                Giving you a chart with direct airline links means they earn nothing.
              </p>
            </div>
          </div>
          <div className={styles.reason}>
            <span className={styles.reasonNumber}>3</span>
            <div>
              <h3 className={styles.reasonTitle}>Airlines don&apos;t want price transparency</h3>
              <p className={styles.reasonText}>
                If you can see that a route always dips 3 weeks before departure,
                that undermines dynamic pricing. That&apos;s why there&apos;s no public API.
              </p>
            </div>
          </div>
        </div>
      </section>

      {!isSelfHosted && (
        <section className={styles.how}>
          <h2 className={styles.whyTitle}>How it works</h2>
          <div className={styles.steps}>
            <div className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <div>
                <h3 className={styles.reasonTitle}>Install in one command</h3>
                <p className={styles.reasonText}>
                  The setup script auto-detects Claude Code or Codex on your machine.
                  If you have either, no API key needed. Or run a local model with Ollama, llama.cpp, or vLLM &mdash; completely free.
                </p>
              </div>
            </div>
            <div className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <div>
                <h3 className={styles.reasonTitle}>Search in plain English</h3>
                <p className={styles.reasonText}>
                  Type &ldquo;NYC to Tokyo next month under $800&rdquo; and Flight Finder
                  starts tracking prices across airlines every 3 hours.
                </p>
              </div>
            </div>
            <div className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <div>
                <h3 className={styles.reasonTitle}>See the real trend</h3>
                <p className={styles.reasonText}>
                  Get a shareable chart showing price evolution over time.
                  Click any data point to book directly with the airline.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!isSelfHosted && (
        <section className={styles.notSection}>
          <h2 className={styles.whyTitle}>What Flight Finder is not</h2>
          <div className={styles.notItems}>
            <div className={styles.notItem}>
              <span className={styles.notIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>Not an aggregator</h3>
                <p className={styles.reasonText}>
                  No ads, no affiliate links, no sponsored rankings.
                  Flight Finder doesn&apos;t make money when you book &mdash; it just shows you the data.
                </p>
              </div>
            </div>
            <div className={styles.notItem}>
              <span className={styles.notIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>Not an AI provider</h3>
                <p className={styles.reasonText}>
                  AI is becoming a commodity &mdash; we don&apos;t bundle or resell it.
                  Bring your own key, use Claude Code / Codex, or run Ollama / llama.cpp / vLLM locally.
                </p>
              </div>
            </div>
            <div className={styles.notItem}>
              <span className={styles.notIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>Not a price predictor</h3>
                <p className={styles.reasonText}>
                  No black-box &ldquo;buy now&rdquo; advice. Flight Finder shows you real price
                  history and lets you decide when the moment is right.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!isSelfHosted && (
        <section className={styles.selfHost}>
          <h2 className={styles.whyTitle}>Why self-hosted?</h2>
          <p className={styles.selfHostLead}>
            Decentralization isn&apos;t a philosophy &mdash; it&apos;s the only design that works.
          </p>
          <div className={styles.benefits}>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>It can&apos;t work any other way</h3>
                <p className={styles.reasonText}>
                  A centralized service scraping Google Flights gets IP-banned within days.
                  Thousands of self-hosted instances, each making a few quiet requests from
                  different IPs, is the only architecture that survives.
                </p>
              </div>
            </div>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>Your searches stay private</h3>
                <p className={styles.reasonText}>
                  No one sees what routes you&apos;re watching or when you&apos;re planning to travel.
                  Airlines can&apos;t use your search history against you.
                </p>
              </div>
            </div>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>Free with Claude Code, Codex, or a local model</h3>
                <p className={styles.reasonText}>
                  Use your existing CLI subscription, or run Ollama / llama.cpp / vLLM locally &mdash; zero API cost.
                  Otherwise, extraction costs under $0.001 per query.
                </p>
              </div>
            </div>
            <div className={styles.benefit}>
              <span className={styles.benefitIcon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.354 5.354-4 4a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7 9.293l3.646-3.647a.5.5 0 0 1 .708.708Z" fill="currentColor"/></svg>
              </span>
              <div>
                <h3 className={styles.reasonTitle}>You control the scrape frequency</h3>
                <p className={styles.reasonText}>
                  Default is every 3 hours. Want every hour? Change one setting.
                  Your data, your database &mdash; export it, analyze it, keep it forever.
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
