export const LOCALES = ['en', 'es', 'pt', 'de', 'fr'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'ft-locale';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  pt: 'Português',
  de: 'Deutsch',
  fr: 'Français',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
