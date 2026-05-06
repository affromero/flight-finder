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
  it('ignores sold-out snapshots when picking the best price', () => {
    // A sold-out snapshot at a lower price should not win — its listing is
    // gone and the user can't actually book at that price anymore.
    render(
      <BestPrice
        snapshots={[
          snap({ price: 96, status: 'sold_out', airline: 'Turkish' }),
          snap({ price: 175, status: 'available', airline: 'Pegasus' }),
        ]}
      />,
    );

    expect(screen.queryByText(/Best price found/)).toBeTruthy();
    expect(screen.getByText(/175/)).toBeTruthy();
    expect(screen.queryByText(/96$/)).toBeNull();
  });

  it('renders nothing when every snapshot is sold out', () => {
    const { container } = render(
      <BestPrice
        snapshots={[
          snap({ price: 96, status: 'sold_out' }),
          snap({ price: 110, status: 'sold_out' }),
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('still picks the cheapest available snapshot when none are sold out', () => {
    render(
      <BestPrice
        snapshots={[
          snap({ price: 320, airline: 'Lufthansa' }),
          snap({ price: 220, airline: 'United' }),
          snap({ price: 410, airline: 'Air France' }),
        ]}
      />,
    );
    expect(screen.getByText(/220/)).toBeTruthy();
  });

  it('falls back gracefully when snapshots have no status field', () => {
    // Defensive: callers passing legacy data without `status` should still work.
    render(
      <BestPrice
        snapshots={[
          { ...snap({ price: 150 }), status: undefined },
          { ...snap({ price: 90 }), status: undefined },
        ]}
      />,
    );
    expect(screen.getByText(/90/)).toBeTruthy();
  });
});
