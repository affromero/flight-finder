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

    expect(screen.queryByText(/Best price found/)).toBeTruthy();
    expect(screen.getByText(/175/)).toBeTruthy();
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
    expect(screen.getByText(/220/)).toBeTruthy();
  });

  it('falls back gracefully when snapshots have no status field', async () => {
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
    expect(screen.getByText(/90/)).toBeTruthy();
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
