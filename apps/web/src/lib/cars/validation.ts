import { Temporal } from '@js-temporal/polyfill';
import { carImportUrl } from './import-url';
import { isCarCountry } from './countries';
import { CAR_SOURCES, CHILD_SEAT_CATEGORIES, CarError, type CarDriver, type CarExtras, type CarLocalTime, type CarLocation, type CarSearch, type CarTrackingOptions } from './types';
import { validateCarProviders } from './preferences';
import { currencyPrecision, validateCarMoney } from './money';

export function carRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CarError('Expected an object');
  return raw as Record<string, unknown>;
}
export function carText(raw: unknown, max: number, label: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /\p{Cc}/u.test(raw)) throw new CarError(`Invalid ${label}`);
  return raw.trim();
}
export function carInteger(raw: unknown, min: number, max: number, label: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) throw new CarError(`${label} must be between ${min} and ${max}`);
  return raw;
}
function boolean(raw: unknown, defaultValue = false): boolean {
  if (raw === undefined) return defaultValue;
  if (typeof raw !== 'boolean') throw new CarError('Expected a boolean');
  return raw;
}
export function validateCarCountry(raw: unknown): string {
  const code = carText(raw, 2, 'country').toUpperCase();
  if (!isCarCountry(code)) throw new CarError('Choose a valid country');
  return code;
}
function timeZone(raw: unknown): string {
  const zone = carText(raw, 100, 'station timezone');
  if (/^[+-]/.test(zone)) throw new CarError('Station timezone must be an IANA name, not a fixed offset');
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { throw new CarError('Choose a valid station timezone'); }
}
export function validateCarLocalDateTime(raw: unknown): Pick<CarLocalTime, 'date' | 'time'> {
  const r = carRecord(raw);
  const date = carText(r.date, 10, 'date');
  const time = carText(r.time, 5, 'local time');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new CarError('Use YYYY-MM-DD and HH:mm local time');
  try { Temporal.PlainDateTime.from(`${date}T${time}`, { overflow: 'reject' }); }
  catch { throw new CarError('Invalid local date or time'); }
  return { date, time };
}
export function resolveCarLocalTime(raw: unknown, stationTimeZone?: string): CarLocalTime {
  const r = carRecord(raw), { date, time } = validateCarLocalDateTime(raw);
  const zone = timeZone(stationTimeZone ?? r.timeZone);
  if (r.timeZone !== undefined && timeZone(r.timeZone) !== zone) throw new CarError('Time must use the selected station timezone');
  try {
    const local = Temporal.PlainDateTime.from(`${date}T${time}`, { overflow: 'reject' });
    const instant = local.toZonedDateTime(zone, { disambiguation: 'reject' }).toInstant().toString();
    // A client-supplied instant is never authoritative. Recompute it from the
    // station timezone so forged offsets cannot change the requested rental.
    return { date, time, timeZone: zone, instant };
  } catch { throw new CarError('Invalid or ambiguous local time; choose a time outside the daylight-saving transition'); }
}
export function validateCarDriver(raw: unknown): CarDriver {
  const r = carRecord(raw);
  const age = carInteger(r.age, 18, 99, 'Driver age');
  const licenceYears = carInteger(r.licenceYears, 0, age - 16, 'Years holding a licence');
  return { age, licenceYears, residenceCountry: validateCarCountry(r.residenceCountry) };
}
function location(raw: unknown): CarLocation {
  const r = carRecord(raw);
  const ids = carRecord(r.providerIds);
  const providerIds: CarLocation['providerIds'] = {};
  const names = r.providerNames === undefined ? {} : carRecord(r.providerNames);
  const providerNames: CarLocation['providerNames'] = {};
  for (const source of CAR_SOURCES) {
    if (ids[source] !== undefined) providerIds[source] = carText(ids[source], 200, 'provider location');
    if (names[source] !== undefined) providerNames[source] = carText(names[source], 250, 'provider location name');
  }
  let catalog: CarLocation['catalog'];
  if (r.catalog !== undefined) {
    const value = carRecord(r.catalog);
    const id = carText(value.id, 80, 'catalog location'), version = carText(value.version, 64, 'catalog version');
    if (!/^(?:geonames|ourairports):\d+$/.test(id) || !/^[a-f0-9]{64}$/.test(version)) throw new CarError('Invalid rental location catalog identity');
    catalog = { id, version };
  }
  return { name: carText(r.name, 250, 'location'), country: validateCarCountry(r.country), timeZone: timeZone(r.timeZone), providerIds, providerNames, ...(catalog ? { catalog } : {}) };
}
export function validateCarExtras(raw: unknown): CarExtras {
  const r = carRecord(raw ?? {});
  const seats = r.childSeats ?? [], drivers = r.additionalDrivers ?? [], protection = r.protection ?? [];
  if (!Array.isArray(seats) || seats.length > 3 || !Array.isArray(drivers) || drivers.length > 4 || !Array.isArray(protection) || protection.length > CAR_SOURCES.length) throw new CarError('Too many requested extras');
  const childSeats = seats.map(rawSeat => {
    const seat = carRecord(rawSeat);
    const category = CHILD_SEAT_CATEGORIES.find(value => value === seat.category);
    if (!category) throw new CarError('Choose infant, child or booster seats');
    return { category, quantity: carInteger(seat.quantity, 1, 4, 'Seat quantity') };
  });
  if (new Set(childSeats.map(s => s.category)).size !== childSeats.length || childSeats.reduce((sum, s) => sum + s.quantity, 0) > 4) throw new CarError('Choose up to four seats without duplicate categories');
  const products = protection.map(rawProduct => {
    const product = carRecord(rawProduct);
    const source = CAR_SOURCES.find(value => value === product.source);
    if (!source) throw new CarError('Unsupported protection provider');
    return { source, productId: carText(product.productId, 200, 'protection product') };
  });
  if (new Set(products.map(p => p.source)).size !== products.length) throw new CarError('Choose one protection product per provider');
  return { childSeats, additionalDrivers: drivers.map(validateCarDriver), protection: products };
}
export function validateCarSearch(raw: unknown, now = new Date(), options: { allowUnresolvedProviders?: boolean } = {}): CarSearch {
  const r = carRecord(raw);
  const pickup = location(r.pickup), dropoff = location(r.dropoff);
  const pickupAt = resolveCarLocalTime(r.pickupAt, pickup.timeZone);
  const dropoffAt = resolveCarLocalTime(r.dropoffAt, dropoff.timeZone);
  const start = Date.parse(pickupAt.instant), end = Date.parse(dropoffAt.instant);
  if (start <= now.getTime() || end <= start) throw new CarError('Choose future pickup and a later return');
  if (end - start > 90 * 86_400_000 || start - now.getTime() > 730 * 86_400_000) throw new CarError('Rentals must be within two years and no longer than 90 days');
  const currency = carText(r.currency, 3, 'currency').toUpperCase();
  currencyPrecision(currency);
  const sources = validateCarProviders(r.sources);
  const sourceUrl = carImportUrl(r.sourceUrl, sources);
  for (const source of sources) {
    for (const place of [pickup, dropoff]) {
      if (!place.providerIds[source] && !(options.allowUnresolvedProviders && place.catalog)) throw new CarError(`Select pickup and return locations for ${source}`);
    }
  }
  const extras = validateCarExtras(r.extras);
  if (extras.protection.length && sources.some(s => !extras.protection.some(p => p.source === s))) throw new CarError('Choose a protection product for every selected provider');
  if (extras.protection.some(p => !sources.includes(p.source))) throw new CarError('Protection must belong to a selected provider');
  let protectionRecheck: CarSearch['protectionRecheck'];
  if (r.protectionRecheck !== undefined) {
    const binding = carRecord(r.protectionRecheck);
    if (Object.keys(binding).some(key => !['searchId', 'offerId', 'choiceId', 'baseContractHash', 'baseCoverageTerms'].includes(key))
      || sources.length !== 1 || extras.protection.length !== 1) throw new CarError('Invalid protected rental recheck');
    const choiceId = carText(binding.choiceId, 36, 'protection choice');
    const baseContractHash = carText(binding.baseContractHash, 64, 'base rental identity');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(choiceId) || !/^[a-f0-9]{64}$/.test(baseContractHash)) throw new CarError('Invalid protected rental identity');
    protectionRecheck = { searchId: carText(binding.searchId, 200, 'original search'), offerId: carText(binding.offerId, 200, 'original offer'), choiceId, baseContractHash, baseCoverageTerms: carText(binding.baseCoverageTerms, 12000, 'base coverage terms') };
  }
  return {
    pickup, dropoff, pickupAt, dropoffAt, driver: validateCarDriver(r.driver), currency, sources, extras,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(protectionRecheck ? { protectionRecheck } : {}),
    filters: validateCarFilters(r.filters, currency),
  };
}
export function validateCarFilters(raw: unknown, currency: string): CarSearch['filters'] {
  const f = carRecord(raw ?? {}), transmission = f.transmission ?? 'any';
  if (transmission !== 'any' && transmission !== 'automatic' && transmission !== 'manual') throw new CarError('Unknown transmission');
  return { transmission, minSeats: carInteger(f.minSeats ?? 4, 2, 9, 'Minimum seats'), unlimitedMileage: boolean(f.unlimitedMileage), freeCancellation: boolean(f.freeCancellation), maxTotal: f.maxTotal == null ? null : validateCarMoney(f.maxTotal, currency) };
}
export function validateCarOptions(raw: unknown, currency?: string): CarTrackingOptions {
  const r = carRecord(raw);
  const mode = r.mode ?? 'best';
  if (mode !== 'best' && mode !== 'contract') throw new CarError('Unknown tracking mode');
  return { mode, target: r.target == null ? null : validateCarMoney(r.target, currency), notifyLows: boolean(r.notifyLows, true), scrapeInterval: carInteger(r.scrapeInterval ?? 3, 1, 24, 'Check interval') };
}
