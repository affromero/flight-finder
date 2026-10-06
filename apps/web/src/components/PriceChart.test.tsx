/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Capture the onClick prop PriceChart passes to its dynamically-imported Plot.
// Mocking next/dynamic to return a tiny prop-capturing stub avoids loading the
// heavyweight react-plotly.js canvas dependency and does not depend on how
// dynamic() resolves its loader module.
const plot = vi.hoisted(() => ({
  onClick: undefined as ((data: object) => void) | undefined,
  onError: undefined as ((error: Error) => void) | undefined,
  onUpdate: undefined as (() => void) | undefined,
}));

vi.mock('next/dynamic', () => ({
  default: () => {
    const Stub = (props: { onClick?: (data: object) => void; onError?: (error: Error) => void; onUpdate?: () => void }) => {
      plot.onClick = props.onClick;
      plot.onError = props.onError;
      plot.onUpdate = props.onUpdate;
      return null;
    };
    return Stub;
  },
}));

import { PriceChart } from './PriceChart';

function makeSnapshot(overrides: { bookingUrl?: string | null } = {}) {
  return {
    id: 's1',
    travelDate: '2026-12-01',
    price: 350,
    currency: 'USD',
    airline: 'Delta',
    bookingUrl: overrides.bookingUrl ?? 'https://flights.google.com/book?q=1',
    stops: 0,
    duration: '5h 30m',
    flightId: 'DL123',
    departureTime: '08:00',
    arrivalTime: '13:30',
    seatsLeft: null,
    status: 'available',
    airlineDirectPrice: null,
    vpnCountry: null,
    scrapedAt: '2026-06-01T10:00:00.000Z',
  };
}

// Retrieve the onClick handler that PriceChart passed to <Plot>.
function getPlotOnClick(): ((data: object) => void) | undefined {
  return plot.onClick;
}

describe('PriceChart: booking URL security (M6/M7)', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    plot.onClick = undefined;
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    openSpy.mockRestore();
    localStorage.clear();
  });

  it('keeps airline grouping as the default and remembers an explicit flight view', () => {
    const initial = render(<PriceChart snapshots={[makeSnapshot()]} trackerId="chart-preference-test" />);
    const grouping = screen.getByRole('combobox', { name: 'Group by' });
    expect(grouping).toHaveValue('airline');
    fireEvent.change(grouping, { target: { value: 'flight' } });
    initial.unmount();
    render(<PriceChart snapshots={[makeSnapshot()]} trackerId="chart-preference-test" />);
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue('flight');
  });

  it('surfaces a renderer failure and clears it after a successful draw', () => {
    render(<PriceChart snapshots={[makeSnapshot()]} />);
    act(() => plot.onError?.(new Error('Rendering unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('The chart could not be drawn: Rendering unavailable');
    act(() => plot.onUpdate?.());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens a valid https booking URL with noopener,noreferrer', () => {
    render(<PriceChart snapshots={[makeSnapshot()]} />);

    const onClick = getPlotOnClick();
    expect(onClick).toBeDefined();

    onClick!({
      points: [{ customdata: ['https://flights.google.com/book?q=1'] }],
    });

    expect(openSpy).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledWith(
      'https://flights.google.com/book?q=1',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens the clicked flight when unified hover lists another flight first', () => {
    render(<PriceChart snapshots={[makeSnapshot()]} />);
    getPlotOnClick()!({
      event: { clientX: 50, clientY: 200 },
      points: [
        { bbox: { x0: 47, x1: 53, y0: 97, y1: 103 }, customdata: ['https://booking.example/DL101'] },
        { bbox: { x0: 47, x1: 53, y0: 197, y1: 203 }, customdata: ['https://booking.example/DL102'] },
      ],
    });
    expect(openSpy).toHaveBeenCalledWith('https://booking.example/DL102', '_blank', 'noopener,noreferrer');
  });

  it('does not guess a flight when prices overlap or the pointer coordinate is missing', () => {
    render(<PriceChart snapshots={[makeSnapshot()]} />);
    const points = [
      { bbox: { x0: 47, x1: 53, y0: 97, y1: 103 }, customdata: ['https://booking.example/DL101'] },
      { bbox: { x0: 47, x1: 53, y0: 97, y1: 103 }, customdata: ['https://booking.example/DL102'] },
    ];
    getPlotOnClick()!({ event: { clientX: 50, clientY: 100 }, points });
    getPlotOnClick()!({ points });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open a neighboring flight when the clicked sold-out point has no booking URL', () => {
    render(<PriceChart snapshots={[makeSnapshot()]} />);
    getPlotOnClick()!({
      event: { clientX: 50, clientY: 200 },
      points: [
        { bbox: { x0: 47, x1: 53, y0: 97, y1: 103 }, customdata: ['https://booking.example/DL101'] },
        { bbox: { x0: 47, x1: 53, y0: 197, y1: 203 }, customdata: [null] },
      ],
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open a javascript: URL', () => {
    render(<PriceChart snapshots={[makeSnapshot({ bookingUrl: 'javascript:alert(1)' })]} />);

    const onClick = getPlotOnClick();
    expect(onClick).toBeDefined();

    onClick!({
      points: [{ customdata: ['javascript:alert(1)'] }],
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open a data: URL', () => {
    render(
      <PriceChart
        snapshots={[makeSnapshot({ bookingUrl: 'data:text/html,<script>alert(1)</script>' })]}
      />,
    );

    const onClick = getPlotOnClick();
    expect(onClick).toBeDefined();

    onClick!({
      points: [{ customdata: ['data:text/html,<script>alert(1)</script>'] }],
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open a null booking URL', () => {
    render(<PriceChart snapshots={[makeSnapshot({ bookingUrl: null })]} />);

    const onClick = getPlotOnClick();
    expect(onClick).toBeDefined();

    onClick!({
      points: [{ customdata: [null] }],
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open when customdata is absent', () => {
    render(<PriceChart snapshots={[makeSnapshot()]} />);

    const onClick = getPlotOnClick();
    expect(onClick).toBeDefined();

    onClick!({ points: [{}] });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens a valid http URL (non-TLS) with noopener,noreferrer', () => {
    render(<PriceChart snapshots={[makeSnapshot({ bookingUrl: 'http://example.com/book' })]} />);

    const onClick = getPlotOnClick();
    expect(onClick).toBeDefined();

    onClick!({
      points: [{ customdata: ['http://example.com/book'] }],
    });

    expect(openSpy).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledWith(
      'http://example.com/book',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
