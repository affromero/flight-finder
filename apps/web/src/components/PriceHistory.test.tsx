/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PriceHistory, type Snapshot } from './PriceHistory';

// Issue #89: the grouped-by-flight view ordered parent rows by lifetime-cheapest
// price, so a flight last seen days ago (or a stale "cheapest ever") interleaved
// with currently-live flights and you couldn't read today's situation. The view
// now defaults to a flat snapshot of the latest scrape only (cheapest first),
// with the full chronological log behind a "Show full history" toggle.

function snap(over: Partial<Snapshot> & Pick<Snapshot, 'id' | 'flightId' | 'airline' | 'price' | 'scrapedAt'>): Snapshot {
  return {
    currency: 'USD',
    bookingUrl: 'https://example.com/book',
    stops: 0,
    duration: '5h 30m',
    flightNumber: null,
    departureTime: null,
    arrivalTime: null,
    seatsLeft: null,
    status: 'available',
    airlineDirectPrice: null,
    vpnCountry: null,
    ...over,
  };
}

// Alpha and Beta are present in the latest scrape (May 3). Gamma was the cheapest
// price ever seen but only appeared on May 1, then disappeared.
const SNAPSHOTS: Snapshot[] = [
  snap({ id: 'a1', flightId: 'A', airline: 'Alpha', price: 350, scrapedAt: '2026-05-01T08:00:00.000Z' }),
  snap({ id: 'a2', flightId: 'A', airline: 'Alpha', price: 320, scrapedAt: '2026-05-02T08:00:00.000Z' }),
  snap({ id: 'a3', flightId: 'A', airline: 'Alpha', price: 300, scrapedAt: '2026-05-03T08:00:00.000Z' }),
  snap({ id: 'b1', flightId: 'B', airline: 'Beta', price: 250, scrapedAt: '2026-05-01T08:00:00.000Z' }),
  snap({ id: 'b2', flightId: 'B', airline: 'Beta', price: 210, scrapedAt: '2026-05-02T08:00:00.000Z' }),
  snap({ id: 'b3', flightId: 'B', airline: 'Beta', price: 200, scrapedAt: '2026-05-03T08:00:00.000Z' }),
  snap({ id: 'c1', flightId: 'C', airline: 'Gamma', price: 150, scrapedAt: '2026-05-01T08:00:00.000Z' }),
];

describe('PriceHistory: latest snapshot + full history (issue #89)', () => {
  it('shows only the latest scrape by default, hiding earlier checks', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);

    // Latest price of each live flight is visible...
    expect(screen.getByText(/\b300\b/)).toBeInTheDocument();
    expect(screen.getByText(/\b200\b/)).toBeInTheDocument();

    // ...earlier checks are hidden until expanded.
    expect(screen.queryByText(/\b350\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b320\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b250\b/)).not.toBeInTheDocument();
  });

  it('excludes flights absent from the latest scrape, even if they were the cheapest ever', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);

    // Gamma (150) was the lifetime-cheapest but is gone from the latest scrape,
    // so it must not surface in the current snapshot.
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    expect(screen.queryByText(/\b150\b/)).not.toBeInTheDocument();
  });

  it('orders the latest scrape cheapest first', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);

    const dataRows = screen
      .getAllByRole('row')
      .map((r) => r.textContent ?? '')
      .filter((t) => t.includes('USD'));

    expect(dataRows[0]).toMatch(/Beta/); // 200
    expect(dataRows[1]).toMatch(/Alpha/); // 300
  });

  it('reveals the full chronological log when full history is shown', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);

    fireEvent.click(screen.getByRole('button', { name: /show full history/i }));

    // Earlier checks and the vanished flight now appear.
    expect(screen.getByText(/\b350\b/)).toBeInTheDocument();
    expect(screen.getByText(/\b210\b/)).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText(/\b150\b/)).toBeInTheDocument();
  });

  it('labels the toggle with the total number of checks', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);
    expect(screen.getByRole('button', { name: /show full history \(7 checks\)/i })).toBeInTheDocument();
  });

  it('omits the full-history toggle when there is only one scrape', () => {
    const single = [
      snap({ id: 'x1', flightId: 'X', airline: 'Solo', price: 400, scrapedAt: '2026-05-03T08:00:00.000Z' }),
    ];
    render(<PriceHistory snapshots={single} />);
    expect(screen.queryByRole('button', { name: /full history/i })).not.toBeInTheDocument();
  });

  it('renders nothing when there are no snapshots', () => {
    const { container } = render(<PriceHistory snapshots={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
