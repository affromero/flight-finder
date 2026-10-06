import { describe, expect, it } from 'vitest';
import { chartTraceUid, flightSeriesKey, flightVisibilityKey } from './identity';

const flight = {
  id: 'observation-1', flightId: 'Delta-640-JFK-LAX-2027-06-15', airline: 'Delta',
  flightNumber: null, departureTime: '6:40 AM', arrivalTime: '09:00',
  travelDate: '2027-06-15', currency: 'USD', vpnCountry: null,
};

describe('flight display identity', () => {
  it('encodes stable trace ids without CSS selector syntax or Unicode collisions', () => {
    const identities = ['Delta (USD)', '["Delta-640", "CA"]', '航空', '\ud800', '\ud801', ''];
    const ids = identities.map(chartTraceUid);
    expect(new Set(ids).size).toBe(identities.length);
    expect(ids.every(id => /^trace-[0-9a-f]*$/.test(id))).toBe(true);
    expect(chartTraceUid(identities[0]!)).toBe(ids[0]);
  });
  it('distinguishes morning and evening departures with colliding legacy ids', () => {
    expect(flightVisibilityKey(flight)).not.toBe(flightVisibilityKey({ ...flight, departureTime: '6:40 PM' }));
    expect(flightVisibilityKey(flight)).toBe(flightVisibilityKey({ ...flight, departureTime: '06:40' }));
  });

  it('shares visibility across exits while keeping trend series independent', () => {
    const vpn = { ...flight, vpnCountry: 'CA' };
    expect(flightVisibilityKey(flight)).toBe(flightVisibilityKey(vpn));
    expect(flightSeriesKey(flight)).not.toBe(flightSeriesKey(vpn));
  });

  it('keeps currencies and travel dates independent', () => {
    expect(flightVisibilityKey(flight)).not.toBe(flightVisibilityKey({ ...flight, currency: 'EUR' }));
    expect(flightVisibilityKey(flight)).not.toBe(flightVisibilityKey({ ...flight, travelDate: '2027-06-16' }));
  });

  it('retains separate unidentifiable observations', () => {
    const unknown = { ...flight, flightId: null, departureTime: null };
    expect(flightVisibilityKey(unknown)).not.toBe(flightVisibilityKey({ ...unknown, id: 'observation-2' }));
  });

  it('retains unknown observations that share a generated legacy sentinel id', () => {
    const unknown = { ...flight, flightId: 'Delta-0000-JFK-LAX-2027-06-15', departureTime: null };
    expect(flightVisibilityKey(unknown)).not.toBe(flightVisibilityKey({ ...unknown, id: 'observation-2' }));
  });

  it('keeps distinct unnumbered arrivals independent at the same departure clock', () => {
    expect(flightVisibilityKey(flight)).not.toBe(flightVisibilityKey({ ...flight, arrivalTime: '10:00' }));
  });

  it('keeps a numbered flight together when its schedule changes', () => {
    const numbered = { ...flight, flightNumber: 'DL100' };
    expect(flightVisibilityKey(numbered)).toBe(flightVisibilityKey({ ...numbered, departureTime: '07:00' }));
  });
});
