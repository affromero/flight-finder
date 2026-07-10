const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  KRW: '₩',
  INR: '₹',
  CHF: 'CHF',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  HKD: 'HK$',
  SGD: 'S$',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  BRL: 'R$',
  MXN: 'MX$',
  THB: '฿',
  TRY: '₺',
  ZAR: 'R',
  ILS: '₪',
  COP: 'COL$',
  ARS: 'AR$',
  CLP: 'CL$',
  PEN: 'S/',
  UYU: 'UY$',
  PYG: '₲',
  BOB: 'Bs',
  VES: 'Bs.',
  CRC: '₡',
  GTQ: 'Q',
  HNL: 'L',
  NIO: 'C$',
  DOP: 'RD$',
  PAB: 'B/.',
  CUP: 'CU$',
  TWD: 'NT$',
  VND: '₫',
  IDR: 'Rp',
  MYR: 'RM',
  PHP: '₱',
  RUB: '₽',
  UAH: '₴',
  CZK: 'Kč',
  RON: 'lei',
  HUF: 'Ft',
  NGN: '₦',
  EGP: 'E£',
};

export function currencySymbol(code: string): string {
  return SYMBOLS[code] ?? code;
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
