/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmationCard, type ParsedQuery } from '../ConfirmationCard';

const parsed: ParsedQuery = {
  origin: 'JFK', originName: 'New York', destination: 'LAX', destinationName: 'Los Angeles',
  origins: [{ code: 'JFK', name: 'New York' }], destinations: [{ code: 'LAX', name: 'Los Angeles' }],
  dateFrom: '2027-05-01', dateTo: '2027-05-20', flexibility: 0, tripType: 'round_trip',
  maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [],
  timePreference: 'any', cabinClass: 'economy', currency: 'USD',
};

describe('flight confirmation tracking end', () => {
  it.each([
    [{}, 'May 2, 2027'],
    [{ outboundDates: ['2027-05-01', '2027-05-03'], returnDates: ['2027-05-20'] }, 'May 4, 2027'],
    [{ dateFrom: '2027-05-10', outboundDates: ['2027-05-01'], returnDates: ['2027-05-20'] }, 'May 2, 2027'],
    [{ tripType: 'one_way', dateTo: '2027-05-05', flexibility: 2 }, 'May 6, 2027'],
  ])('shows expiry after the last preview outbound date for %j', (fields, expected) => {
    render(<ConfirmationCard parsed={{ ...parsed, ...fields }} loading={false} onTrack={() => undefined} onEdit={() => undefined} />);
    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.getByText(/Prices checked daily/)).toHaveTextContent(`Tracking ends ${expected}`);
  });
});
