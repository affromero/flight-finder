import { travelImportUrl } from '../travel/import-url';
import type { ParsedFlightQuery } from './parse-query';

interface Field { id: number; value: bigint | Uint8Array }
export interface FlightLinkSegment { origin: string; destination: string; date: string; airline: string; number: string }
export interface FlightLink { url: string; legs: FlightLinkSegment[][]; cabinClass: ParsedFlightQuery['cabinClass'] }

function fields(bytes: Uint8Array): Field[] {
  let offset = 0;
  const integer = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined) break;
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid Google Flights link data');
  };
  const result: Field[] = [];
  while (offset < bytes.length) {
    const tag = Number(integer()), wire = tag & 7;
    if (tag < 8 || result.length >= 100) throw new Error('Invalid Google Flights link fields');
    if (wire === 0) { result.push({ id: tag >> 3, value: integer() }); continue; }
    if (wire !== 2) throw new Error('Unsupported Google Flights link encoding');
    const length = Number(integer());
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Error('Truncated Google Flights link');
    result.push({ id: tag >> 3, value: bytes.slice(offset, offset + length) }); offset += length;
  }
  return result;
}
function message(field: Field): Field[] {
  if (!(field.value instanceof Uint8Array)) throw new Error('Invalid itinerary in Google Flights link');
  return fields(field.value);
}
function text(entries: Field[], id: number, pattern: RegExp): string {
  const values = entries.filter(field => field.id === id);
  const value = values[0]?.value;
  if (values.length !== 1 || !(value instanceof Uint8Array)) throw new Error('The link does not contain a complete selected itinerary');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
  if (!pattern.test(decoded)) throw new Error('Invalid flight details in the selected link');
  return decoded;
}
function date(entries: Field[], id: number): string {
  const value = text(entries, id, /^\d{4}-\d{2}-\d{2}$/);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid flight date');
  return value;
}

export function readFlightLink(raw: unknown): FlightLink {
  const { url } = travelImportUrl(raw, 'flights');
  const encoded = new URL(url).searchParams.get('tfs')!;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) || encoded.length > 12000) throw new Error('Invalid Google Flights itinerary encoding');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)); }
  catch { throw new Error('Invalid Google Flights itinerary encoding'); }
  const root = fields(bytes);
  const legs = root.filter(field => field.id === 3).map(field => {
    const leg = message(field), departure = date(leg, 2);
    const segments = leg.filter(field => field.id === 4).map(field => {
      const segment = message(field);
      return { origin: text(segment, 1, /^[A-Z]{3}$/), destination: text(segment, 3, /^[A-Z]{3}$/), date: date(segment, 2), airline: text(segment, 5, /^[A-Z0-9]{2}$/), number: text(segment, 6, /^\d{1,4}[A-Z]?$/) };
    });
    if (!segments.length || segments.length > 4 || segments[0]!.date !== departure) throw new Error('Select all flights before copying the booking link');
    for (let index = 1; index < segments.length; index++) {
      if (segments[index - 1]!.destination !== segments[index]!.origin || segments[index]!.date < segments[index - 1]!.date) throw new Error('The selected flight connections are inconsistent');
    }
    return segments;
  });
  if (!legs.length || legs.length > 2) throw new Error('Import supports selected one-way and round-trip itineraries');
  if (legs.length === 2 && (legs[1]![0]!.origin !== legs[0]!.at(-1)!.destination || legs[1]!.at(-1)!.destination !== legs[0]![0]!.origin || legs[1]![0]!.date <= legs[0]![0]!.date)) throw new Error('Import requires a round trip returning to the departure airport');
  const cabins = ['economy', 'premium_economy', 'business', 'first'] as const;
  const cabin = root.find(field => field.id === 9)?.value;
  const cabinClass = typeof cabin === 'bigint' ? cabins[Number(cabin) - 1] : undefined;
  if (!cabinClass) throw new Error('The selected link does not specify a supported cabin');
  // Existing flight trackers price one adult. Do not relabel a group fare.
  const travelers = root.filter(field => field.id === 8);
  if (travelers.length !== 1 || travelers[0]!.value !== 1n) throw new Error('Flight link import currently supports one adult');
  return { url, legs, cabinClass };
}

export function flightLinkQuery(raw: unknown): ParsedFlightQuery {
  const link = readFlightLink(raw), first = link.legs[0]![0]!, last = link.legs[0]!.at(-1)!;
  const outbound = first.date, inbound = link.legs[1]?.[0]?.date;
  const currency = new URL(link.url).searchParams.get('curr');
  if (currency && !Intl.supportedValuesOf('currency').includes(currency)) throw new Error('Unsupported flight currency');
  return { sourceUrl: link.url, origin: first.origin, originName: first.origin, destination: last.destination, destinationName: last.destination,
    origins: [{ code: first.origin, name: first.origin }], destinations: [{ code: last.destination, name: last.destination }],
    dateFrom: outbound, dateTo: inbound ?? outbound, outboundDates: [outbound], returnDates: inbound ? [inbound] : [], flexibility: 0,
    maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any', cabinClass: link.cabinClass, tripType: inbound ? 'round_trip' : 'one_way', currency };
}

export function assertFlightLinkSearch(raw: unknown, search: { origin: string; destination: string; dateFrom: string; dateTo: string; cabinClass: string; tripType: string; flexibility?: number }): void {
  const expected = flightLinkQuery(raw);
  if (['origin', 'destination', 'dateFrom', 'dateTo', 'cabinClass', 'tripType'].some(key => expected[key as keyof typeof expected] !== search[key as keyof typeof search]) || (search.flexibility ?? 0) !== 0) throw new Error('The flight link must keep its original route, dates and cabin. Remove the link to change the search.');
}
