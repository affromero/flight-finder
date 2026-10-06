import { departureClockMinutes } from '../../criteria/departure';

interface FlightIdentity {
  airline: string;
  departureTime?: string | null;
  flightNumber?: string | null;
  travelDate: string;
}

/** Retain the legacy time key so older observations can match numbered flights. */
export function flightIdentifiers(origin: string, destination: string, flight: FlightIdentity) {
  const timePart = (flight.departureTime ?? '').replace(/[^0-9]/g, '') || '0000';
  const airlinePart = flight.airline.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
  const numberPart = (flight.flightNumber ?? '').replace(/\s+/g, '').toUpperCase();
  const suffix = `${origin}-${destination}-${flight.travelDate}`;
  return {
    flightId: `${airlinePart}-${numberPart || timePart}-${suffix}`,
    flightIdLegacy: `${airlinePart}-${timePart}-${suffix}`,
  };
}

/** Reconciliation requires a known local clock; persisted legacy IDs are lossy. */
export function flightDepartureAlias(origin: string, destination: string, flight: FlightIdentity): string | null {
  const minutes = departureClockMinutes(flight.departureTime);
  if (minutes === null) return null;
  const airline = flightIdentifiers(origin, destination, flight).flightIdLegacy.split('-')[0];
  return JSON.stringify([airline, origin, destination, flight.travelDate, minutes]);
}
