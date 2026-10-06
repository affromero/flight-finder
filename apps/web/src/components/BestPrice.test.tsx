/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BestPrice } from './BestPrice';

interface Snap {
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  departureTime: string | null;
  arrivalTime: string | null;
  duration: string | null;
  layovers?: unknown;
  vpnCountry: string | null;
  scrapedAt: string;
  status?: string;
  flightId?: string | null;
  flightNumber?: string | null;
  travelDate?: string;
}

function snap(overrides: Partial<Snap>): Snap {
  return {
    price: 200,
    currency: 'USD',
    airline: 'Delta',
    bookingUrl: null,
    stops: 0,
    departureTime: null,
    arrivalTime: null,
    duration: null,
    vpnCountry: null,
    scrapedAt: '2026-05-01T00:00:00.000Z',
    status: 'available',
    ...overrides,
  };
}

describe('BestPrice — sold-out exclusion (issue #64)', () => {
  it('ignores sold-out snapshots when picking the best price', async () => {
    // A sold-out snapshot at a lower price should not win — its listing is
    // gone and the user can't actually book at that price anymore.
    render(
      <>
        {await BestPrice({
          snapshots: [
            snap({ price: 96, status: 'sold_out', airline: 'Turkish' }),
            snap({ price: 175, status: 'available', airline: 'Pegasus' }),
          ],
        })}
      </>,
    );

    expect(screen.queryByText(/Latest observed price/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Latest observed price' })).toHaveTextContent(/175/);
    expect(screen.queryByText(/96$/)).toBeNull();
  });

  it('renders nothing when every snapshot is sold out', async () => {
    const { container } = render(
      <>
        {await BestPrice({
          snapshots: [
            snap({ price: 96, status: 'sold_out' }),
            snap({ price: 110, status: 'sold_out' }),
          ],
        })}
      </>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('still picks the cheapest available snapshot when none are sold out', async () => {
    render(
      <>
        {await BestPrice({
          snapshots: [
            snap({ price: 320, airline: 'Lufthansa' }),
            snap({ price: 220, airline: 'United' }),
            snap({ price: 410, airline: 'Air France' }),
          ],
        })}
      </>,
    );
    expect(screen.getByRole('region', { name: 'Latest observed price' })).toHaveTextContent(/220/);
  });

  it('reads legacy observations whose status is absent', async () => {
    // Defensive: callers passing legacy data without `status` should still work.
    render(
      <>
        {await BestPrice({
          snapshots: [
            { ...snap({ price: 150 }), status: undefined },
            { ...snap({ price: 90 }), status: undefined },
          ],
        })}
      </>,
    );
    expect(screen.getByRole('region', { name: 'Latest observed price' })).toHaveTextContent(/90/);
  });
});

describe('latest fares and historical lows', () => {
  it('books the newer fare while keeping the historical low as dated information', async () => {
    render(<>{await BestPrice({ snapshots: [
      snap({ price: 90, flightId: 'one', bookingUrl: 'https://old.example/fare' }),
      snap({ price: 240, flightId: 'one', bookingUrl: 'https://new.example/fare', scrapedAt: '2026-05-02T00:00:00.000Z' }),
    ] })}</>);
    expect(screen.getByRole('region', { name: 'Latest observed price' })).toHaveTextContent(/240/);
    const history = screen.getByRole('complementary', { name: 'Historical low' });
    expect(history).toHaveTextContent(/90/);
    expect(history).toHaveTextContent(/May/);
    expect(screen.getByRole('link', { name: 'Book on Delta' })).toHaveAttribute('href', 'https://new.example/fare');
    expect(history.querySelector('a')).toBeNull();
  });

  it.each([
    { status: 'sold_out', price: 90 },
    { status: 'available', price: 240 },
  ])('keeps history without offering an older booking when the latest observation is unavailable or over budget %j', async change => {
    render(<>{await BestPrice({
      snapshots: [snap({ flightId: 'one', price: 90, bookingUrl: 'https://old.example/fare' }),
        snap({ ...change, flightId: 'one', scrapedAt: '2026-05-02T00:00:00.000Z' })],
      filters: { maxPrice: 100, maxStops: null, maxDurationHours: null, preferredAirlines: [] },
    })}</>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/No latest observation matches/)).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Historical low' })).toHaveTextContent(/90/);
  });

  it('does not numerically compare fares from different currencies', async () => {
    render(<>{await BestPrice({ currency: 'USD', snapshots: [
      snap({ flightId: 'usd', price: 240, bookingUrl: 'https://usd.example/fare' }),
      snap({ flightId: 'eur', currency: 'EUR', price: 90, bookingUrl: 'https://eur.example/fare' }),
    ] })}</>);
    expect(screen.getByRole('region', { name: 'Latest observed price' })).toHaveTextContent(/240/);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://usd.example/fare');
    expect(screen.getByRole('complementary', { name: 'Historical low' })).toHaveTextContent(/240/);
  });
});

describe('BestPrice — air time (issue #190)', () => {
  it('breaks the gate-to-gate duration down into time actually in the air', async () => {
    render(
      <>
        {await BestPrice({
          snapshots: [
            snap({ stops: 1, duration: '5h 55m', layovers: [{ duration: '1h 35m', airport: 'ORD' }] }),
          ],
        })}
      </>
    );
    expect(screen.getByText(/5h 55m/)).toBeTruthy();
    expect(screen.getByText(/4h 20m in air/)).toBeTruthy();
  });

  it('shows the duration alone when there is no layover data', async () => {
    render(
      <>{await BestPrice({ snapshots: [snap({ stops: 0, duration: '3h 05m' })] })}</>
    );
    expect(screen.queryByText(/in air/)).toBeNull();
  });
});
