import { describe, it, expect } from 'vitest';
import { formatNewLowMessage, formatPrice } from './format';
import type { NewLowAlert } from './detect';

const norm = (s: string) => s.replace(/\s/g, ' ');

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
    expect(norm(msg.title)).toBe('New low: LHR to JFK USD 250');
    expect(norm(msg.body)).toContain('dropped to USD 250 on United');
    expect(norm(msg.body)).toContain('was USD 300, down USD 50');
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

  it('prefers the chart link over the booking link when a base url is set', () => {
    const msg = formatNewLowMessage({
      alert: ALERT, // bookingUrl: https://book/x
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: 'https://flights.example',
    });
    expect(msg.url).toBe('https://flights.example/q/q-abc');
    expect(msg.data.chartUrl).toBe('https://flights.example/q/q-abc');
    expect(msg.data.bookingUrl).toBe('https://book/x');
  });

  it('falls back to the booking link when no base url is set (self-hosted, unset)', () => {
    const msg = formatNewLowMessage({
      alert: ALERT,
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: null,
    });
    expect(msg.url).toBe('https://book/x');
    expect(norm(msg.body)).toContain('dropped to USD 250'); // price/route still present
  });

  it('emits no link when there is no base url and no usable booking url', () => {
    const msg = formatNewLowMessage({
      alert: { ...ALERT, bookingUrl: null },
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: null,
    });
    expect(msg.url).toBe('');
    expect(norm(msg.body)).toContain('dropped to USD 250');
  });

  it('rejects a dangerous booking url scheme instead of linking to it', () => {
    const msg = formatNewLowMessage({
      alert: { ...ALERT, bookingUrl: 'javascript:alert(1)' },
      route: { origin: 'LHR', destination: 'JFK' },
      baseUrl: null,
    });
    expect(msg.url).toBe('');
  });
});

describe('formatPrice', () => {
  it('formats an integer amount with its code and no decimals', () => {
    expect(norm(formatPrice(250, 'USD'))).toBe('USD 250');
    expect(formatPrice(250, 'EUR')).toContain('250');
    expect(norm(formatPrice(250, null))).toBe('USD 250');
  });

  it('renders a well-formed but unknown currency code via Intl', () => {
    expect(formatPrice(250, 'ZZZ')).toContain('250');
  });

  it('falls back to a plain number for a malformed currency code', () => {
    expect(formatPrice(250, 'US')).toBe('250 US');
  });
});
