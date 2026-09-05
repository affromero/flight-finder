import { DEFAULT_HOTEL_FILTERS, HOTEL_AMENITIES, HOTEL_SOURCES, type HotelSearch, type HotelStay, type HotelOffer, type HotelSelection, type HotelTrackingOptions } from './types';

export class HotelError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'HotelError'; }
}
export const MAX_HOTEL_COMBINATIONS = 24;
const DAY = 86_400_000;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HotelError('Expected an object');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new HotelError(`${label} must be between ${min} and ${max}`);
  return value;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HotelError(`Invalid ${label}`);
  return value.trim();
}
function date(value: unknown): string {
  const str = text(value, 10, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || !Number.isFinite(Date.parse(str)) || new Date(str).toISOString().slice(0, 10) !== str) throw new HotelError('Dates must be valid YYYY-MM-DD values');
  return str;
}
function boolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new HotelError('Expected a boolean');
  return value;
}
export function hotelPrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) throw new HotelError('Price must be a positive finite amount');
  return value;
}
export function validateHotelSearch(raw: unknown, now = new Date()): HotelSearch {
  const r = record(raw);
  const destination = text(r.destination, 250, 'destination');
  const checkIn = date(r.checkIn), checkOut = date(r.checkOut);
  if (checkIn < now.toISOString().slice(0, 10) || checkOut <= checkIn) throw new HotelError('Choose future check-in and a later check-out');
  if (Date.parse(checkOut) - Date.parse(checkIn) > 90 * DAY) throw new HotelError('Search window cannot exceed 90 days');
  const dateMode = r.dateMode ?? 'fixed';
  if (dateMode !== 'fixed' && dateMode !== 'nearby' && dateMode !== 'window') throw new HotelError('Unknown date mode');
  const currency = text(r.currency ?? 'USD', 3, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf('currency').includes(currency)) throw new HotelError('Unsupported currency');
  if (!Array.isArray(r.rooms) || r.rooms.length === 0 || r.rooms.length > 4) throw new HotelError('Choose between one and four rooms');
  const rooms = r.rooms.map((room) => {
    const v = record(room);
    if (!Array.isArray(v.children) || v.children.length > 4) throw new HotelError('Provide up to four child ages per room');
    return { adults: integer(v.adults, 1, 6, 'Adults per room'), children: v.children.map(a => integer(a, 0, 17, 'Child age')) };
  });
  const sources = r.sources ?? [...HOTEL_SOURCES];
  if (!Array.isArray(sources) || !sources.length || sources.some(s => !HOTEL_SOURCES.includes(s))) throw new HotelError('Choose supported hotel sources');
  const f = record(r.filters ?? {});
  const excluded = f.excludedSellers ?? [];
  if (!Array.isArray(excluded) || excluded.length > 20) throw new HotelError('Too many excluded sellers');
  const amenities = f.amenities ?? [];
  if (!Array.isArray(amenities) || amenities.some(a => !HOTEL_AMENITIES.includes(a))) throw new HotelError('Unknown amenity');
  const rating = f.minRating ?? 0;
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10) throw new HotelError('Guest rating must be between 0 and 10');
  const search: HotelSearch = {
    destination, checkIn, checkOut, dateMode, currency, rooms, sources: [...new Set(sources)],
    flexibility: integer(r.flexibility ?? 0, 0, 3, 'Date flexibility'),
    minNights: integer(r.minNights ?? 1, 1, 30, 'Minimum nights'),
    maxNights: integer(r.maxNights ?? 7, 1, 30, 'Maximum nights'),
    filters: { ...DEFAULT_HOTEL_FILTERS, maxTotal: hotelPrice(f.maxTotal), refundable: boolean(f.refundable), breakfast: boolean(f.breakfast), minStars: integer(f.minStars ?? 0, 0, 5, 'Hotel class'), minRating: rating, excludedSellers: excluded.map(s => text(s, 100, 'seller')), amenities: [...new Set(amenities)] },
  };
  if (search.maxNights < search.minNights) throw new HotelError('Maximum nights must be at least minimum nights');
  expandHotelStays(search, now);
  return search;
}
export function expandHotelStays(search: HotelSearch, now = new Date()): HotelStay[] {
  const start = Date.parse(search.checkIn), end = Date.parse(search.checkOut);
  const today = Date.parse(now.toISOString().slice(0, 10));
  const stays: HotelStay[] = [];
  const add = (a: number, b: number) => {
    if (a < today || b <= a || b - a > 30 * DAY) return;
    stays.push({ checkIn: new Date(a).toISOString().slice(0, 10), checkOut: new Date(b).toISOString().slice(0, 10) });
    if (stays.length * search.sources.length > MAX_HOTEL_COMBINATIONS) throw new HotelError(`Search exceeds ${MAX_HOTEL_COMBINATIONS} date/source combinations; narrow dates or choose one source`);
  };
  if (search.dateMode === 'fixed') add(start, end);
  if (search.dateMode === 'nearby') {
    for (let a = -search.flexibility; a <= search.flexibility; a++) {
      for (let b = -search.flexibility; b <= search.flexibility; b++) add(start + a * DAY, end + b * DAY);
    }
  }
  if (search.dateMode === 'window') {
    for (let a = start; a < end; a += DAY) {
      for (let n = search.minNights; n <= search.maxNights && a + n * DAY <= end; n++) add(a, a + n * DAY);
    }
  }
  if (!stays.length) throw new HotelError('No valid stays in this date range');
  return stays;
}
export function validateHotelOptions(raw: unknown): HotelTrackingOptions {
  const r = record(raw);
  const mode = r.mode ?? 'best';
  if (mode !== 'best' && mode !== 'room') throw new HotelError('Unknown tracking mode');
  return { mode, targetPrice: hotelPrice(r.targetPrice), notifyLows: boolean(r.notifyLows, true), allowApproximateAlerts: boolean(r.allowApproximateAlerts), scrapeInterval: integer(r.scrapeInterval ?? 3, 1, 24, 'Check interval') };
}
const normalize = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function matchesHotelFilters(offer: HotelOffer, search: HotelSearch, ignoreBudget = false): boolean {
  const f = search.filters;
  if (!offer.taxesIncluded || !offer.occupancyVerified || !Number.isFinite(offer.totalPrice) || offer.totalPrice <= 0 || offer.currency !== search.currency) return false;
  if (JSON.stringify(offer.rooms) !== JSON.stringify(search.rooms)) return false;
  if (!ignoreBudget && f.maxTotal !== null && offer.totalPrice > f.maxTotal) return false;
  if (f.refundable && offer.refundable !== true) return false;
  if (f.breakfast && offer.breakfast !== true) return false;
  if (f.minStars > 0 && (offer.stars === null || offer.stars < f.minStars)) return false;
  if (f.minRating > 0 && (offer.rating === null || offer.rating < f.minRating)) return false;
  if (f.amenities.some(a => offer.amenities[a] !== true)) return false;
  return !f.excludedSellers.some(s => normalize(offer.seller).includes(normalize(s)));
}
export function matchHotelSelection(offer: HotelOffer, selection: HotelSelection, mode: HotelTrackingOptions['mode']): 'exact' | 'approximate' | null {
  if (offer.source !== selection.source || offer.propertyId !== selection.propertyId) return null;
  if (mode === 'best') return 'exact';
  if (!offer.roomName || !selection.roomName || normalize(offer.seller) !== normalize(selection.seller)) return null;
  if (offer.refundable !== selection.refundable || offer.breakfast !== selection.breakfast) return null;
  if (normalize(offer.roomName) === normalize(selection.roomName) && offer.providerRateId && offer.providerRateId === selection.providerRateId && offer.match === 'exact') return 'exact';
  const requested = normalize(selection.roomName).split(' ').filter(t => t.length > 2);
  const candidate = new Set(normalize(offer.roomName).split(' '));
  return requested.length > 0 && requested.filter(t => candidate.has(t)).length / requested.length >= 0.75 ? 'approximate' : null;
}
export interface HotelAlertState { targetArmed: boolean; historicalLow: number | null }
export function evaluateHotelAlerts(state: HotelAlertState, options: HotelTrackingOptions, price: number | null, complete: boolean): { target: boolean; low: boolean; state: HotelAlertState } {
  if (price === null || !Number.isFinite(price) || price <= 0) return { target: false, low: false, state };
  const qualifies = options.targetPrice !== null && price <= options.targetPrice;
  const target = qualifies && state.targetArmed;
  const low = options.notifyLows && state.historicalLow !== null && price < state.historicalLow;
  return { target, low, state: { targetArmed: target ? false : complete && options.targetPrice !== null && price > options.targetPrice ? true : state.targetArmed, historicalLow: state.historicalLow === null ? price : Math.min(state.historicalLow, price) } };
}
