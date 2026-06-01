/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FlightPicker, type RouteFlights } from './FlightPicker';
import type { PriceData } from '@/lib/scraper/extract-prices';

// The per-route selection cap used to be a hardcoded 10 (issue #89). It is now
// driven by ExtractionConfig.maxTrackedPerRoute, threaded in as a prop. These
// tests pin the behaviour an admin sees after raising or lowering that value.

function flight(n: number): PriceData {
  return {
    travelDate: '2026-11-16',
    price: 100 + n,
    currency: 'USD',
    airline: `Air${n}`,
    bookingUrl: null,
    stops: 0,
    duration: '5h 30m',
    departureTime: null,
    arrivalTime: null,
    seatsLeft: null,
    flightNumber: null,
  };
}

function route(count: number): RouteFlights {
  return {
    origin: 'JFK',
    originName: 'New York',
    destination: 'LAX',
    destinationName: 'Los Angeles',
    flights: Array.from({ length: count }, (_, i) => flight(i)),
  };
}

function renderPicker(count: number, max?: number) {
  return render(
    <FlightPicker
      routes={[route(count)]}
      onTrack={vi.fn()}
      onBack={vi.fn()}
      onEdit={vi.fn()}
      loading={false}
      {...(max === undefined ? {} : { maxSelectionsPerRoute: max })}
    />,
  );
}

describe('FlightPicker — configurable per-route selection cap (issue #89)', () => {
  it('pre-selects only up to the configured cap when flights exceed it', () => {
    const { container } = renderPicker(12, 3);
    // 12 flights available, cap of 3 -> first 3 pre-selected.
    expect(screen.getByRole('button', { name: /track 3 flights/i })).toBeInTheDocument();
    expect(container.textContent).toContain('3 of 3 selected');
    expect(container.textContent).toContain('Select up to 3 flights');
  });

  it('honours a raised cap so more than 10 flights can be tracked', () => {
    // Before #89 this was impossible: the hardcoded 10 capped both the
    // pre-selection and the counter regardless of admin config.
    const { container } = renderPicker(15, 12);
    expect(screen.getByRole('button', { name: /track 12 flights/i })).toBeInTheDocument();
    expect(container.textContent).toContain('12 of 12 selected');
  });

  it('falls back to a default cap of 10 when no prop is supplied', () => {
    renderPicker(15);
    expect(screen.getByRole('button', { name: /track 10 flights/i })).toBeInTheDocument();
  });

  it('refuses to select beyond the cap once it is reached', () => {
    renderPicker(6, 2);

    // Start from a clean slate so we exercise the add path, not pre-selection.
    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.getByRole('button', { name: /track 0 flights/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Air0/ }));
    fireEvent.click(screen.getByRole('button', { name: /Air1/ }));
    expect(screen.getByRole('button', { name: /track 2 flights/i })).toBeInTheDocument();

    // Cap reached: a third, unselected flight row is disabled and clicking is a no-op.
    const third = screen.getByRole('button', { name: /Air2/ });
    expect(third).toBeDisabled();
    fireEvent.click(third);
    expect(screen.getByRole('button', { name: /track 2 flights/i })).toBeInTheDocument();
  });
});
