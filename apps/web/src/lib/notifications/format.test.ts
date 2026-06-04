import { describe, it, expect } from 'vitest';
import { formatNewLowMessage, formatPrice } from './format';
import type { NewLowAlert } from './detect';

const ALERT: NewLowAlert = {
  queryId: 'q-abc',
  currentMin: 250,
  baseline: 300,
  drop: 50,
  currency: 'USD',
  airline: 'United',
  bookingUrl: 'https://book/x',
  travelDate: new Date('2026-08-01T00:00:00Z'),
  flightNumber: 'UA 900',
};

describe('formatNewLowMessage', () => {
  it('builds a title, body, deep link, and structured data', () => {
    const msg = formatNewLowMessage({
      alert: ALERT,
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: 'https://flights.example',
    });
    expect(msg.title).toBe('New low: LHR to JFK $250');
    expect(msg.body).toContain('dropped to $250 on United');
    expect(msg.body).toContain('was $300, down $50');
    expect(msg.body).toContain('2026-08-01');
    expect(msg.url).toBe('https://flights.example/q/q-abc');
    expect(msg.data).toMatchObject({
      queryId: 'q-abc',
      origin: 'LHR',
      destination: 'JFK',
      currentMin: 250,
      baseline: 300,
      drop: 50,
      travelDate: '2026-08-01',
    });
  });

  it('strips a trailing slash from the base url', () => {
    const msg = formatNewLowMessage({
      alert: ALERT,
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: 'https://flights.example/',
    });
    expect(msg.url).toBe('https://flights.example/q/q-abc');
  });

  it('emits no link when the base url is null (self-hosted, unset)', () => {
    const msg = formatNewLowMessage({
      alert: ALERT,
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: null,
    });
    expect(msg.url).toBe('');
    // The price/route content is still there.
    expect(msg.body).toContain('dropped to $250');
  });
});

describe('formatPrice', () => {
  it('formats known currencies with their symbol and no decimals', () => {
    expect(formatPrice(250, 'USD')).toBe('$250');
    expect(formatPrice(250, 'EUR')).toContain('250');
    expect(formatPrice(250, null)).toBe('$250');
  });

  it('renders a well-formed but unknown currency code via Intl', () => {
    expect(formatPrice(250, 'ZZZ')).toContain('250');
  });

  it('falls back to a plain number for a malformed currency code', () => {
    expect(formatPrice(250, 'US')).toBe('250 US');
  });
});
