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
  const match = flight.departureTime?.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (meridiem) hour = hour % 12 + (meridiem === 'PM' ? 12 : 0);
  const airline = flightIdentifiers(origin, destination, flight).flightIdLegacy.split('-')[0];
  return JSON.stringify([airline, origin, destination, flight.travelDate, hour * 60 + minute]);
}
