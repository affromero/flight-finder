const CURRENCY_LOCALE: Record<string, string> = {
  USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', JPY: 'ja-JP', CNY: 'zh-CN',
  CHF: 'de-CH', CAD: 'en-CA', AUD: 'en-AU', NZD: 'en-NZ',
  SEK: 'sv-SE', NOK: 'nb-NO', DKK: 'da-DK', PLN: 'pl-PL', RUB: 'ru-RU',
  TRY: 'tr-TR', CZK: 'cs-CZ', UAH: 'uk-UA',
  COP: 'es-CO', MXN: 'es-MX', ARS: 'es-AR', CLP: 'es-CL', PEN: 'es-PE',
  BOB: 'es-BO', PYG: 'es-PY', UYU: 'es-UY', VES: 'es-VE', CRC: 'es-CR',
  GTQ: 'es-GT', PAB: 'es-PA', DOP: 'es-DO', NIO: 'es-NI', HNL: 'es-HN',
  CUP: 'es-CU', BRL: 'pt-BR',
  INR: 'hi-IN', KRW: 'ko-KR', TWD: 'zh-TW', HKD: 'zh-HK', SGD: 'en-SG',
  THB: 'th-TH', VND: 'vi-VN', IDR: 'id-ID', MYR: 'ms-MY', PHP: 'en-PH',
  AED: 'ar-AE', SAR: 'ar-SA', ILS: 'he-IL', ZAR: 'en-ZA', NGN: 'en-NG',
};

const currencyFormatters = new Map<string, Intl.NumberFormat>();

export function formatCurrency(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  const code = (currency || 'USD').toUpperCase();
  const locale = CURRENCY_LOCALE[code] ?? 'en-US';
  let formatter = currencyFormatters.get(code);
  if (!formatter) {
    try {
      const options: Intl.NumberFormatOptions & { trailingZeroDisplay?: 'auto' | 'stripIfInteger' } = {
        style: 'currency',
        currency: code,
        currencyDisplay: 'code',
        trailingZeroDisplay: 'stripIfInteger',
      };
      formatter = new Intl.NumberFormat(locale, options);
    } catch {
      return `${new Intl.NumberFormat(locale, { style: 'decimal', maximumFractionDigits: 2 }).format(amount)} ${code}`;
    }
    currencyFormatters.set(code, formatter);
  }
  return formatter.format(amount);
}

/** Detect a likely currency from the user's browser locale. Server-safe fallback to USD. */
export function detectLocaleCurrency(): string {
  if (typeof navigator === 'undefined') return 'USD';

  try {
    const locale = navigator.language || 'en-US';
    // Use Intl to resolve the locale's currency
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })
      .resolvedOptions();

    // Map common locale regions to currencies
    const region = locale.split('-')[1]?.toUpperCase() ?? '';
    const REGION_CURRENCY: Record<string, string> = {
      US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR',
      NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', IE: 'EUR', FI: 'EUR',
      GR: 'EUR', JP: 'JPY', CN: 'CNY', KR: 'KRW', IN: 'INR', CH: 'CHF',
      CA: 'CAD', AU: 'AUD', NZ: 'NZD', HK: 'HKD', SG: 'SGD', SE: 'SEK',
      NO: 'NOK', DK: 'DKK', PL: 'PLN', BR: 'BRL', MX: 'MXN', TH: 'THB',
      TR: 'TRY', ZA: 'ZAR', IL: 'ILS', CO: 'COP',
    };

    return REGION_CURRENCY[region] ?? parts.locale?.split('-')[1]?.toUpperCase() ?? 'USD';
  } catch {
    return 'USD';
  }
}
