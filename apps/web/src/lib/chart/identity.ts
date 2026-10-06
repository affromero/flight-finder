import { flightDepartureAlias, flightIdentifiers } from '../scraper/identity/flight';

interface ChartFlight {
  id: string;
  airline: string;
  flightId: string | null;
  flightNumber?: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  travelDate?: string;
  currency: string;
  vpnCountry: string | null;
}

/** View choices span countries, while dates and currencies remain independent. */
export function flightVisibilityKey(snapshot: ChartFlight): string {
  const flight = { ...snapshot, travelDate: snapshot.travelDate?.slice(0, 10) ?? '' };
  const clock = snapshot.flightNumber?.trim() ? null : flightDepartureAlias('', '', flight);
  const unknownLegacy = !snapshot.flightNumber?.trim() && !clock && snapshot.flightId?.split('-')[1] === '0000';
  const persisted = unknownLegacy ? null : snapshot.flightId?.trim() || null;
  const identity = persisted ?? (snapshot.flightNumber?.trim()
    ? flightIdentifiers('', '', flight).flightId : clock ?? `observation:${snapshot.id}`);
  return JSON.stringify([identity, clock, !snapshot.flightNumber?.trim() && clock ? snapshot.arrivalTime : null, flight.travelDate, snapshot.currency]);
}

/** Trend calculations never compare fares observed through different exits. */
export function flightSeriesKey(snapshot: ChartFlight): string {
  return JSON.stringify([flightVisibilityKey(snapshot), snapshot.vpnCountry]);
}

/** Plotly uses trace IDs in CSS selectors during redraw and cleanup. */
export function chartTraceUid(identity: string): string {
  return `trace-${Array.from({ length: identity.length }, (_, index) => identity.charCodeAt(index).toString(16).padStart(4, '0')).join('')}`;
}
