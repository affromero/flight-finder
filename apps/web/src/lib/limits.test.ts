import { describe, it, expect } from 'vitest';
import { MAX_PRICE_VALUE, isValidPriceAmount } from './limits';

describe('isValidPriceAmount', () => {
  it('accepts high-denomination currency prices that exceeded the old 1M cap', () => {
    expect(isValidPriceAmount(2_550_760)).toBe(true);
    expect(isValidPriceAmount(50_000_000)).toBe(true);
    expect(isValidPriceAmount(1_000_000)).toBe(true);
  });

  it('accepts ordinary small prices and zero', () => {
    expect(isValidPriceAmount(0)).toBe(true);
    expect(isValidPriceAmount(450)).toBe(true);
  });

  it('rejects negatives, NaN and non-finite values', () => {
    expect(isValidPriceAmount(-1)).toBe(false);
    expect(isValidPriceAmount(NaN)).toBe(false);
    expect(isValidPriceAmount(Infinity)).toBe(false);
    expect(isValidPriceAmount(-Infinity)).toBe(false);
  });

  it('rejects values beyond the safe-integer ceiling', () => {
    expect(isValidPriceAmount(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidPriceAmount(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('uses the JS safe-integer ceiling, not an arbitrary business number', () => {
    expect(MAX_PRICE_VALUE).toBe(Number.MAX_SAFE_INTEGER);
  });
});
