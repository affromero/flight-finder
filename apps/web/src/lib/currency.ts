const CURRENCY_LOCALE: Record<string, string> = {
  USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', JPY: 'ja-JP', CNY: 'zh-CN',
  CHF: 'de-CH', CAD: 'en-CA', AUD: 'en-AU', NZD: 'en-NZ',
  SEK: 'sv-SE', NOK: 'nb-NO', DKK: 'da-DK', PLN: 'pl-PL', RUB: 'ru-RU',
  TRY: 'tr-TR', CZK: 'cs-CZ', UAH: 'uk-UA', RON: 'ro-RO', HUF: 'hu-HU',
  BGN: 'bg-BG',
  COP: 'es-CO', MXN: 'es-MX', ARS: 'es-AR', CLP: 'es-CL', PEN: 'es-PE',
  BOB: 'es-BO', PYG: 'es-PY', UYU: 'es-UY', VES: 'es-VE', CRC: 'es-CR',
  GTQ: 'es-GT', PAB: 'es-PA', DOP: 'es-DO', NIO: 'es-NI', HNL: 'es-HN',
  CUP: 'es-CU', BRL: 'pt-BR',
  INR: 'hi-IN', KRW: 'ko-KR', TWD: 'zh-TW', HKD: 'zh-HK', SGD: 'en-SG',
  THB: 'th-TH', VND: 'vi-VN', IDR: 'id-ID', MYR: 'ms-MY', PHP: 'en-PH',
  AED: 'ar-AE', SAR: 'ar-SA', ILS: 'he-IL', ZAR: 'en-ZA', NGN: 'en-NG',
  EGP: 'ar-EG',
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

const COUNTRY_CURRENCY: Record<string, string> = {
  AR: 'ARS', BO: 'BOB', BR: 'BRL', CL: 'CLP', CO: 'COP', CR: 'CRC', CU: 'CUP',
  DO: 'DOP', EC: 'USD', GT: 'GTQ', HN: 'HNL', MX: 'MXN', NI: 'NIO', PA: 'PAB',
  PE: 'PEN', PY: 'PYG', SV: 'USD', UY: 'UYU', VE: 'VES', PR: 'USD',
  US: 'USD', CA: 'CAD',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR',
  PT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', GB: 'GBP', CH: 'CHF', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', PL: 'PLN', RU: 'RUB', TR: 'TRY', UA: 'UAH', CZ: 'CZK',
  JP: 'JPY', CN: 'CNY', KR: 'KRW', IN: 'INR', TW: 'TWD', HK: 'HKD', SG: 'SGD',
  TH: 'THB', VN: 'VND', ID: 'IDR', MY: 'MYR', PH: 'PHP', AE: 'AED', SA: 'SAR',
  IL: 'ILS', AU: 'AUD', NZ: 'NZD', ZA: 'ZAR', NG: 'NGN', EG: 'EGP',
  SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', HR: 'EUR', MT: 'EUR',
  CY: 'EUR', LU: 'EUR', RO: 'RON', BG: 'BGN', HU: 'HUF',
};

export function currencyForLocale(locale: string): string {
  try {
    const region = new Intl.Locale(locale).maximize().region ?? '';
    return COUNTRY_CURRENCY[region] ?? 'USD';
  } catch {
    return 'USD';
  }
}

/** Detect a likely currency from the user's browser locale. Server-safe fallback to USD. */
export function detectLocaleCurrency(): string {
  if (typeof navigator === 'undefined') return 'USD';
  return currencyForLocale(navigator.language || 'en-US');
}
