import { describe, it, expect } from 'vitest';
import { formatCurrency } from './currency';

const norm = (s: string) => s.replace(/\s/g, ' ');

describe('formatCurrency', () => {
  it('shows the currency code and grouped amount with no decimals for an integer COP', () => {
    expect(norm(formatCurrency(228290, 'COP'))).toBe('COP 228.290');
  });

  it('formats each currency in its own locale (COP dot-grouping, USD comma-grouping)', () => {
    expect(norm(formatCurrency(1350.25, 'COP'))).toBe('COP 1.350,25');
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
});
