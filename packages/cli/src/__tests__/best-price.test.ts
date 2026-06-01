import { describe, it, expect } from 'vitest';
import { pickBest, formatBookingLine, type BestPriceSnapshot } from '../lib/best-price.js';

function snap(over: Partial<BestPriceSnapshot> = {}): BestPriceSnapshot {
  return {
    price: 100,
    currency: 'USD',
    airline: 'TestAir',
    stops: 0,
    duration: null,
    bookingUrl: null,
    scrapedAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

describe('pickBest', () => {
  it('returns the lowest priced snapshot', () => {
    const best = pickBest([
      snap({ price: 300, airline: 'A' }),
      snap({ price: 120, airline: 'B' }),
      snap({ price: 250, airline: 'C' }),
    ]);
    expect(best?.price).toBe(120);
    expect(best?.airline).toBe('B');
  });

  it('returns null when there are no snapshots', () => {
    expect(pickBest([])).toBeNull();
  });
});

describe('formatBookingLine', () => {
  it('keeps the full booking url instead of truncating it', () => {
    // Regression for issue 96: the card sliced the url to 33 chars, producing
    // an incomplete link that 404s. The full url must survive intact.
    const url = 'https://www.google.com/travel/flights/booking?tfs=' + 'A'.repeat(80);
    expect(formatBookingLine(url)).toBe(`Book: ${url}`);
  });

  it('returns null when there is no booking url', () => {
    expect(formatBookingLine(null)).toBeNull();
  });
});
