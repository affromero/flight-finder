import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';
import { ClientBeacon } from '@/components/analytics/ClientBeacon';
import { HomeBrand } from '@/components/HomeBrand/HomeBrand';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { THEME_OPTIONS, getThemeMode, isThemeId, DEFAULT_THEME } from '@/lib/theme';

const isSelfHosted = process.env.SELF_HOSTED === 'true';

export const metadata: Metadata = {
  metadataBase: new URL('https://flight-finder.org'),
  title: {
    default: 'Flight Finder — The price trail airlines don\'t show you',
    template: '%s | Flight Finder',
  },
  description:
    'Track flight prices over time with shareable charts. See how fares evolve, compare airlines, and book at the right moment.',
  openGraph: {
    title: 'Flight Finder — The price trail airlines don\'t show you',
    description:
      'Track flight prices over time with shareable charts. See how fares evolve, compare airlines, and book at the right moment.',
    siteName: 'Flight Finder',
    type: 'website',
    locale: 'en_US',
    images: [
      { url: '/og-hero.png', width: 1200, height: 630, alt: 'Flight Finder — paper plane over price evolution chart' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
  },
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Flight Finder',
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-icon.png',
    shortcut: '/favicon.ico',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#031820' },
    { media: '(prefers-color-scheme: light)', color: '#faf6ed' },
  ],
};

const swScript = `
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function() {});
  }
`;

// Theme bootstrap, runs before first paint.
//
// Hosted: apply the visitor's per browser preference (localStorage) over the
// server default so a cold render of /q/[id] doesn't flash the default.
//
// Self hosted: the theme is a global server side setting already rendered into
// `<html data-theme>`, so we do NOT touch it here. A stale localStorage value
// from an old toggle must not override it (issue #89: theme kept resetting on
// /q/[id], which never re-fetches config to self correct like the admin pages).
//
// The id->mode map is derived from THEME_OPTIONS so it never drifts from
// theme.ts. window.__ftSelfHosted lets client components (ThemeToggle) apply the
// same rule without prop drilling.
const themeModeMap = JSON.stringify(
  Object.fromEntries(THEME_OPTIONS.map((t) => [t.id, t.mode])),
);
const themeBootstrapScript = `
  window.__ftSelfHosted = ${isSelfHosted};
  try {
    if (!${isSelfHosted}) {
      var t = localStorage.getItem('ft-theme');
      var m = ${themeModeMap};
      if (t && m[t]) {
        var e = document.documentElement;
        e.setAttribute('data-theme', t);
        e.setAttribute('data-theme-mode', m[t]);
      }
    }
  } catch (e) {}
`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { theme: true },
  }).catch(() => null);
  let theme = isThemeId(config?.theme) ? config.theme : DEFAULT_THEME;

  // Per-user theme: in multi user mode a logged-in member's personal theme
  // overrides the instance default. Rendered into <html data-theme> so the
  // server (DOM) value wins on self hosted, where localStorage is ignored.
  let perUserTheme = false;
  try {
    if (await isMultiUserEnabled()) {
      const user = await getCurrentUser();
      if (user) {
        perUserTheme = true;
        if (isThemeId(user.theme)) theme = user.theme;
      }
    }
  } catch {
    // A transient DB error must not break the layout on every page; fall back
    // to the instance default theme and treat the visitor as non-personalized.
    perUserTheme = false;
  }
  const perUserScript = `window.__ftPerUserTheme = ${perUserTheme};`;

  return (
    <html lang="en" suppressHydrationWarning data-theme={theme} data-theme-mode={getThemeMode(theme)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: perUserScript }} />
        <script dangerouslySetInnerHTML={{ __html: swScript }} />
      </head>
      <body>
        <HomeBrand />
        {children}
        {!isSelfHosted && <ClientBeacon />}
      </body>
    </html>
  );
}
