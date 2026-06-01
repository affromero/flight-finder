/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PriceHistory } from './PriceHistory';
import type { Snapshot } from './FlightHistoryGroup';

// Issue #89: the history table used to render every snapshot as a flat row, so a
// week of scraping turned it into an unreadable wall. It now groups by flight and
// shows one summary row per flight, expandable into that flight's history.

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

// Two flights, three scrapes each. Latest prices: Alpha 300, Beta 200.
const SNAPSHOTS: Snapshot[] = [
  snap({ id: 'a1', flightId: 'A', airline: 'Alpha', price: 350, scrapedAt: '2026-05-01T08:00:00.000Z' }),
  snap({ id: 'a2', flightId: 'A', airline: 'Alpha', price: 320, scrapedAt: '2026-05-02T08:00:00.000Z' }),
  snap({ id: 'a3', flightId: 'A', airline: 'Alpha', price: 300, scrapedAt: '2026-05-03T08:00:00.000Z' }),
  snap({ id: 'b1', flightId: 'B', airline: 'Beta', price: 250, scrapedAt: '2026-05-01T08:00:00.000Z' }),
  snap({ id: 'b2', flightId: 'B', airline: 'Beta', price: 210, scrapedAt: '2026-05-02T08:00:00.000Z' }),
  snap({ id: 'b3', flightId: 'B', airline: 'Beta', price: 200, scrapedAt: '2026-05-03T08:00:00.000Z' }),
];

describe('PriceHistory — grouped by flight (issue #89)', () => {
  it('collapses to one summary row per flight showing only the latest price', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);

    // Latest price of each flight is visible...
    expect(screen.getByText(/\b300\b/)).toBeInTheDocument();
    expect(screen.getByText(/\b200\b/)).toBeInTheDocument();

    // ...but the older history is hidden until expanded.
    expect(screen.queryByText(/\b350\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b320\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b250\b/)).not.toBeInTheDocument();

    // One expand control per flight (both have history).
    expect(screen.getAllByRole('button', { name: /earlier checks/i })).toHaveLength(2);
  });

  it('reveals a flight\'s own history when its summary row is expanded', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);

    fireEvent.click(screen.getByRole('button', { name: /earlier checks for Alpha/i }));

    // Alpha's older prices now show...
    expect(screen.getByText(/\b320\b/)).toBeInTheDocument();
    expect(screen.getByText(/\b350\b/)).toBeInTheDocument();

    // ...while Beta stays collapsed.
    expect(screen.queryByText(/\b250\b/)).not.toBeInTheDocument();
  });

  it('shows a total-checks count so the summary row signals there is history', () => {
    render(<PriceHistory snapshots={SNAPSHOTS} />);
    // Each flight has 3 snapshots.
    expect(screen.getAllByText(/3 checks/).length).toBeGreaterThanOrEqual(2);
  });

  it('renders nothing when there are no snapshots', () => {
    const { container } = render(<PriceHistory snapshots={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
