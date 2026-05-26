import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';
import { ClientBeacon } from '@/components/analytics/ClientBeacon';
import { prisma } from '@/lib/prisma';
import { getThemeMode, isThemeId } from '@/lib/theme';

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

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { theme: true },
  }).catch(() => null);
  const theme = isThemeId(config?.theme) ? config.theme : 'default';

  return (
    <html lang="en" suppressHydrationWarning data-theme={theme} data-theme-mode={getThemeMode(theme)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: swScript }} />
      </head>
      <body>
        {children}
        {!isSelfHosted && <ClientBeacon />}
      </body>
    </html>
  );
}
