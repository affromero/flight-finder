import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './locales';

const AREAS = ['common', 'components', 'pages', 'settings', 'admin'] as const;

async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const areas = await Promise.all(
    AREAS.map(async (area) => (await import(`../../messages/${locale}/${area}.json`)).default),
  );
  return Object.assign({}, ...areas);
}

export default getRequestConfig(async () => {
  const store = await cookies().catch(() => null);
  const cookieLocale = store?.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  const fallback = await loadMessages(DEFAULT_LOCALE);
  const messages = locale === DEFAULT_LOCALE ? fallback : { ...fallback, ...(await loadMessages(locale)) };

  return { locale, messages };
});
