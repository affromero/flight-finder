import { describe, expect, it } from 'vitest';
import { isLegacySplitFare, latestFlightObservations, latestFlightObservationEntries, flightComparisonCurrency, lowestFlightFare } from './flight-pricing';

describe('legacy split fare identification', () => {
  it('recognizes the synthetic label written by older previews', () => {
    expect(isLegacySplitFare('Air Canada + Air Canada (approx OW+OW)')).toBe(true);
  });

  it('preserves real fares including multi-airline itineraries', () => {
    for (const airline of ['Air Canada', 'Air Canada + ANA', 'United', '', null, undefined]) {
      expect(isLegacySplitFare(airline)).toBe(false);
    }
  });
});

const route = { origin: 'JFK', destination: 'LAX' };
const oldTime = '2026-05-01T00:00:00.000Z';
const newTime = '2026-05-02T00:00:00.000Z';
function fare(changes: Partial<ReturnType<typeof baseFare>> = {}) {
  return { ...baseFare(), ...changes };
}
function baseFare() {
  return { price: 200, currency: 'USD', airline: 'Delta', scrapedAt: oldTime,
    travelDate: '2026-06-15', flightId: 'Delta-DL100-JFK-LAX-2026-06-15',
    flightNumber: 'DL100' as string | null, departureTime: '08:00', arrivalTime: '11:00',
    vpnCountry: null as string | null, status: 'available' };
}

describe('latest observed fares', () => {
  it('uses the newer price rather than the historical minimum', () => {
    const old = fare({ price: 90 });
    const current = fare({ price: 240, scrapedAt: newTime });
    expect(lowestFlightFare(latestFlightObservations([current, old], route), 'USD')).toEqual(current);
    expect(lowestFlightFare([current, old], 'USD')).toEqual(old);
  });

  it('does not resurrect a price after a sold-out observation', () => {
    const latest = latestFlightObservations([fare({ price: 90 }), fare({ status: 'sold_out', scrapedAt: newTime })], route);
    expect(lowestFlightFare(latest, 'USD')).toBeNull();
  });

  it('keeps independent travel dates, currency and VPN observations', () => {
    const observations = [fare(), fare({ travelDate: '2026-06-16', price: 190 }),
      fare({ currency: 'EUR', price: 100 }), fare({ vpnCountry: 'DE', price: 180 })];
    expect(latestFlightObservations(observations, route)).toEqual(observations);
    expect(lowestFlightFare(observations, 'USD')?.price).toBe(180);
    expect(lowestFlightFare(observations, 'EUR')?.price).toBe(100);
  });

  it('reconciles a legacy time identity when a flight number becomes available', () => {
    const legacy = fare({ flightId: 'Delta-0800-JFK-LAX-2026-06-15', flightNumber: null, price: 90 });
    const numbered = fare({ scrapedAt: newTime, price: 240 });
    expect(latestFlightObservations([legacy, numbered], route)).toEqual([numbered]);
  });

  it('updates a unique numbered identity when the newest observation omits its number', () => {
    const numbered = fare({ price: 90 });
    const legacy = fare({ flightId: 'Delta-0800-JFK-LAX-2026-06-15', flightNumber: null, scrapedAt: newTime, price: 240 });
    expect(latestFlightObservations([legacy, numbered], route)).toEqual([legacy]);
  });

  it('preserves numbered codeshares at the same departure time', () => {
    const flights = [fare(), fare({ flightNumber: 'DL200', flightId: 'Delta-DL200-JFK-LAX-2026-06-15', price: 190 })];
    expect(latestFlightObservations(flights, route)).toEqual(flights);
  });

  it.each([false, true])('keeps a newly observed unnumbered fare alongside copied numbered sold-out rows, codeshares=%s', codeshares => {
    const legacy = fare({ flightId: 'Delta-0800-JFK-LAX-2026-06-15', flightNumber: null, price: 240, scrapedAt: newTime });
    const rows = [fare({ price: 90 }), legacy, fare({ price: 90, status: 'sold_out', scrapedAt: newTime })];
    if (codeshares) rows.push(fare({ flightNumber: 'DL200', flightId: 'Delta-DL200-JFK-LAX-2026-06-15', status: 'sold_out', scrapedAt: newTime }));
    expect(lowestFlightFare(latestFlightObservations(rows, route), 'USD')).toEqual(legacy);
  });

  it('preserves independent morning and evening flights despite colliding legacy IDs', () => {
    const evening = fare({ departureTime: '08:00 PM', flightNumber: null, flightId: 'Delta-0800-JFK-LAX-2026-06-15', price: 90 });
    const morning = fare({ departureTime: '08:00 AM', scrapedAt: newTime, price: 240 });
    expect(latestFlightObservations([evening, morning], route)).toEqual([evening, morning]);
    const unnumberedMorning = { ...morning, flightNumber: null, flightId: evening.flightId };
    expect(latestFlightObservations([evening, unnumberedMorning], route)).toEqual([evening, unnumberedMorning]);
  });

  it('resolves equal timestamps consistently and retains an unavailable observation over its copied fare', () => {
    const unavailable = fare({ status: 'sold_out' });
    for (const rows of [[fare(), unavailable], [unavailable, fare()]]) {
      expect(lowestFlightFare(latestFlightObservations(rows, route), 'USD')).toBeNull();
    }
    for (const rows of [[fare(), fare({ price: 190 })], [fare({ price: 190 }), fare()]]) {
      expect(lowestFlightFare(latestFlightObservations(rows, route), 'USD')?.price).toBe(190);
    }
  });

  it('excludes estimates and invalid numeric prices from booking selection', () => {
    const rows = [fare({ price: 10, airline: 'Delta (approx OW+OW)' }), fare({ price: Number.NaN }), fare({ price: -1 })];
    expect(lowestFlightFare(rows, 'USD')).toBeNull();
    expect(latestFlightObservations(rows, route).some(row => row.airline.includes('approx'))).toBe(false);
  });
});

describe('fare comparison currency', () => {
  it('uses an explicit tracker currency', () => {
    expect(flightComparisonCurrency([fare()], 'CAD')).toBe('CAD');
  });

  it('anchors auto mode to direct prices even if a VPN pass is newer', () => {
    expect(flightComparisonCurrency([fare(), fare({ currency: 'EUR', vpnCountry: 'DE', scrapedAt: newTime })])).toBe('USD');
  });

  it('uses the newest available VPN currency when direct prices are absent', () => {
    expect(flightComparisonCurrency([fare({ vpnCountry: 'US' }), fare({ currency: 'EUR', vpnCountry: 'DE', scrapedAt: newTime })])).toBe('EUR');
  });

  it('does not anchor comparisons to stale prices copied into unavailable observations', () => {
    expect(flightComparisonCurrency([fare({ currency: 'EUR', status: 'sold_out', scrapedAt: newTime }), fare()])).toBe('USD');
    expect(flightComparisonCurrency([])).toBeNull();
  });
});

describe('flight-specific alert identities', () => {
  it('retains a numbered identity when the latest matching fare omits its number', () => {
    const legacy = fare({ flightId: 'Delta-0800-JFK-LAX-2026-06-15', flightNumber: null, scrapedAt: newTime });
    const entries = latestFlightObservationEntries([fare(), legacy], route);
    expect(entries).toEqual([{ snapshot: legacy, flightId: baseFare().flightId }]);
    expect(entries.map(entry => entry.snapshot)).toEqual(latestFlightObservations([fare(), legacy], route));
  });

  it('does not assign an ambiguous unnumbered fare to either codeshare', () => {
    const other = fare({ flightNumber: 'DL200', flightId: 'Delta-DL200-JFK-LAX-2026-06-15' });
    const legacy = fare({ flightId: 'Delta-0800-JFK-LAX-2026-06-15', flightNumber: null, scrapedAt: newTime });
    const entries = latestFlightObservationEntries([fare(), other, legacy], route);
    expect(entries.find(entry => entry.snapshot === legacy)?.flightId).toBeNull();
    expect(entries.filter(entry => entry.flightId).map(entry => entry.flightId)).toEqual(expect.arrayContaining([baseFare().flightId, other.flightId]));
  });

  it('keeps morning and evening aliases separate despite colliding stored time IDs', () => {
    const morning = fare({ departureTime: '08:00 AM' });
    const evening = fare({ departureTime: '08:00 PM', flightNumber: 'DL200', flightId: 'Delta-DL200-JFK-LAX-2026-06-15' });
    const newer = [morning, evening].map(snapshot => ({ ...snapshot, flightNumber: null, flightId: 'Delta-0800-JFK-LAX-2026-06-15', scrapedAt: newTime }));
    expect(latestFlightObservationEntries([morning, evening, ...newer], route)).toEqual([
      { snapshot: newer[0], flightId: morning.flightId }, { snapshot: newer[1], flightId: evening.flightId },
    ]);
  });
});
