import { describe, it, expect } from 'vitest';
import { currencyForLocale, detectLocaleCurrency, currencySymbol } from './currency';

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

describe('currencySymbol', () => {
  it('returns the symbol for known currencies', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('COP')).toBe('COL$');
  });

  it('falls back to the code itself for currencies without a symbol', () => {
    expect(currencySymbol('ARS')).toBe('ARS');
    expect(currencySymbol('PEN')).toBe('PEN');
  });
});
