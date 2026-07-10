import { describe, it, expect } from 'vitest';
import { formatCurrency, currencyForLocale, detectLocaleCurrency } from './currency';

const norm = (s: string) => s.replace(/\s/g, ' ');

describe('formatCurrency', () => {
  it('shows the currency code and grouped amount with no decimals for an integer COP', () => {
    expect(norm(formatCurrency(228290, 'COP'))).toBe('COP 228.290');
  });

  it('formats each currency in its own locale (COP dot-grouping, USD comma-grouping)', () => {
    // COP cents depend on the ICU version (CLDR says 0 fraction digits, older
    // data says 2), so accept both rather than pin the runtime's ICU.
    expect(norm(formatCurrency(1350.25, 'COP'))).toMatch(/^COP 1\.350(,25)?$/);
    expect(norm(formatCurrency(1234.5, 'USD'))).toBe('USD 1,234.50');
  });

  it('strips decimals for an integer USD amount', () => {
    expect(norm(formatCurrency(250, 'USD'))).toBe('USD 250');
  });

  it('keeps two decimals for a non-integer USD amount', () => {
    expect(norm(formatCurrency(1234.5, 'USD'))).toBe('USD 1,234.50');
  });

  it('returns empty string for null, undefined, NaN and Infinity', () => {
    expect(formatCurrency(null, 'USD')).toBe('');
    expect(formatCurrency(undefined, 'USD')).toBe('');
    expect(formatCurrency(NaN, 'USD')).toBe('');
    expect(formatCurrency(Infinity, 'USD')).toBe('');
    expect(formatCurrency(-Infinity, 'USD')).toBe('');
  });

  it('upper-cases a lowercase currency code', () => {
    expect(norm(formatCurrency(100, 'usd'))).toBe('USD 100');
  });

  it('defaults a missing currency to USD', () => {
    expect(norm(formatCurrency(100, null))).toBe('USD 100');
    expect(norm(formatCurrency(100, undefined))).toBe('USD 100');
  });

  it('falls back to amount plus code consistently for an invalid currency without throwing', () => {
    expect(() => formatCurrency(10, 'ZZ')).not.toThrow();
    expect(formatCurrency(10, 'ZZ')).toBe('10 ZZ');
    expect(formatCurrency(10, 'ZZ')).toBe('10 ZZ');
  });

  it('formats every currency in the locale map without throwing', () => {
    for (const code of ['RON', 'HUF', 'EGP', 'BGN', 'VND', 'CLP', 'INR']) {
      expect(norm(formatCurrency(1234567, code))).toContain(code);
    }
  });
});

describe('currencyForLocale', () => {
  it('resolves country locales to their ISO 4217 currency', () => {
    expect(currencyForLocale('es-CO')).toBe('COP');
    expect(currencyForLocale('es-MX')).toBe('MXN');
    expect(currencyForLocale('pt-BR')).toBe('BRL');
    expect(currencyForLocale('en-US')).toBe('USD');
    expect(currencyForLocale('en-GB')).toBe('GBP');
    expect(currencyForLocale('de-DE')).toBe('EUR');
    expect(currencyForLocale('ja-JP')).toBe('JPY');
  });

  it('resolves Latin American locales the old table missed', () => {
    expect(currencyForLocale('es-AR')).toBe('ARS');
    expect(currencyForLocale('es-CL')).toBe('CLP');
    expect(currencyForLocale('es-PE')).toBe('PEN');
    expect(currencyForLocale('es-VE')).toBe('VES');
    expect(currencyForLocale('es-UY')).toBe('UYU');
    expect(currencyForLocale('es-BO')).toBe('BOB');
    expect(currencyForLocale('es-PY')).toBe('PYG');
    expect(currencyForLocale('es-CR')).toBe('CRC');
    expect(currencyForLocale('es-PA')).toBe('PAB');
    expect(currencyForLocale('es-GT')).toBe('GTQ');
  });

  it('returns a real currency for macro-region locales instead of the region digits', () => {
    for (const loc of ['es-419', 'es-005', 'en-001', 'en-150']) {
      const code = currencyForLocale(loc);
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(code).not.toMatch(/\d/);
    }
  });

  it('resolves EU member locales missing from the old table', () => {
    expect(currencyForLocale('sk-SK')).toBe('EUR');
    expect(currencyForLocale('sl-SI')).toBe('EUR');
    expect(currencyForLocale('hr-HR')).toBe('EUR');
    expect(currencyForLocale('lt-LT')).toBe('EUR');
    expect(currencyForLocale('ro-RO')).toBe('RON');
    expect(currencyForLocale('bg-BG')).toBe('BGN');
    expect(currencyForLocale('hu-HU')).toBe('HUF');
  });

  it('treats script subtags as scripts, not regions', () => {
    expect(currencyForLocale('zh-Hans-CN')).toBe('CNY');
    expect(currencyForLocale('zh-Hant-TW')).toBe('TWD');
  });

  it('always returns a valid 3-letter code, never a locale fragment', () => {
    const locales = [
      'es-419', 'es-AR', 'zh-Hans-CN', 'ru-RU', 'vi-VN', 'id-ID',
      'en-PH', 'ar-AE', 'xx-YY', '', '@@@', 'not_a_locale',
    ];
    for (const loc of locales) {
      expect(currencyForLocale(loc)).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('falls back to USD on unknown or invalid input', () => {
    expect(currencyForLocale('')).toBe('USD');
    expect(currencyForLocale('@@@')).toBe('USD');
    expect(currencyForLocale('xx-YY')).toBe('USD');
  });
});

describe('detectLocaleCurrency', () => {
  it('returns a valid ISO 4217 code', () => {
    expect(detectLocaleCurrency()).toMatch(/^[A-Z]{3}$/);
  });
});
