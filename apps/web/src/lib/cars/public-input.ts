import { CarError } from './types';
import { carImportUrl } from './import-url';
import { currencyPrecision } from './money';
import { validateCarProviders } from './preferences';
import { carRecord, carText, validateCarDriver, validateCarExtras, validateCarFilters, validateCarLocalDateTime } from './validation';

export function carInputFields(raw: unknown, allowed: readonly string[], message = 'Unexpected field in rental input'): Record<string, unknown> {
  const value = carRecord(raw);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new CarError(message);
  return value;
}
function catalogLocation(raw: unknown) {
  const value = carInputFields(raw, ['id', 'version'], 'Select a catalog location; provider identifiers and geography are server-managed');
  const id = carText(value.id, 80, 'catalog location'), version = carText(value.version, 64, 'catalog version');
  if (!/^(?:geonames|ourairports):\d+$/.test(id) || !/^[a-f0-9]{64}$/.test(version)) throw new CarError('Invalid rental location catalog identity');
  return { id, version };
}
const DRIVER_FIELDS = ['age', 'licenceYears', 'residenceCountry'];
function extras(raw: unknown) {
  const value = carInputFields(raw ?? {}, ['childSeats', 'additionalDrivers', 'protection']);
  const itemFields: Record<string, readonly string[]> = {
    childSeats: ['category', 'quantity'], additionalDrivers: DRIVER_FIELDS, protection: ['source', 'productId'],
  };
  for (const [key, items] of Object.entries(value)) {
    if (!Array.isArray(items)) throw new CarError('Expected a list of rental extras');
    for (const item of items) carInputFields(item, itemFields[key]!);
  }
  return validateCarExtras(value);
}

/** Syntax and stable intent only. Catalog geography and date eligibility belong to the server. */
export function normalizeCarSearchInput(raw: unknown) {
  const value = carInputFields(raw, ['pickup', 'dropoff', 'pickupAt', 'dropoffAt', 'driver', 'currency', 'sources', 'extras', 'filters', 'sourceUrl'], 'Unsupported rental search field');
  const currency = carText(value.currency, 3, 'currency').toUpperCase();
  currencyPrecision(currency);
  const filters = carInputFields(value.filters ?? {}, ['transmission', 'minSeats', 'unlimitedMileage', 'freeCancellation', 'maxTotal']);
  if (filters.maxTotal != null) carInputFields(filters.maxTotal, ['currency', 'minor']);
  const sourceUrl = carImportUrl(value.sourceUrl, validateCarProviders(value.sources));
  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    pickup: catalogLocation(value.pickup), dropoff: catalogLocation(value.dropoff),
    pickupAt: validateCarLocalDateTime(carInputFields(value.pickupAt, ['date', 'time'], 'Enter date and local time; the station timezone is server-managed')),
    dropoffAt: validateCarLocalDateTime(carInputFields(value.dropoffAt, ['date', 'time'], 'Enter date and local time; the station timezone is server-managed')),
    driver: validateCarDriver(carInputFields(value.driver, DRIVER_FIELDS)),
    currency, sources: validateCarProviders(value.sources), extras: extras(value.extras),
    filters: validateCarFilters(filters, currency),
  };
}
