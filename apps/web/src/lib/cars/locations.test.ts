import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { carLocationDataPath, decodeCarCatalog, getCarCatalogPlace, searchCarLocations } from './locations';
import { validateCarLocationChoice, type CarLocationChoice } from './location-types';
import { carSearchIntent, carSearchReceipt } from './search-input';
import { validateCarSearch } from './validation';
import { carLocationSuggestions, matchCarProviderLocation } from './location-resolution';

describe('server-owned rental geography', () => {
  let airport: CarLocationChoice;
  beforeAll(async () => { airport = (await searchCarLocations('LHR'))[0]!; }, 60_000);
  it.each(['UK', 'DD', 'FX', 'EU', 'ZZ', 'AC', 'gb'])('rejects noncanonical suggestion country %s', country => {
    expect(() => validateCarLocationChoice({ ...airport, country })).toThrow(/location country/);
  });
  it.each(['GB', 'CW', 'BQ', 'XK'])('accepts canonical suggestion country %s', country => {
    expect(validateCarLocationChoice({ ...airport, country }).country).toBe(country);
  });
  const dates = () => {
    const pickup = new Date(); pickup.setUTCMonth(pickup.getUTCMonth() + 2, 15);
    const dropoff = new Date(pickup); dropoff.setUTCDate(dropoff.getUTCDate() + 3);
    return { pickupAt: { date: pickup.toISOString().slice(0, 10), time: '11:00' }, dropoffAt: { date: dropoff.toISOString().slice(0, 10), time: '11:00' } };
  };
  const input = () => ({ pickup: { id: airport.id, version: airport.version }, dropoff: { id: airport.id, version: airport.version }, ...dates(), driver: { age: 35, licenceYears: 5, residenceCountry: 'GB' }, currency: 'GBP', sources: ['discovercars', 'autoeurope'] });
  it('prioritizes exact airport codes and returns bounded, independently identified places', async () => {
    expect(airport).toMatchObject({ name: 'London Heathrow Airport', iata: 'LHR', country: 'GB', timeZone: 'Europe/London' });
    const london = await searchCarLocations('London United Kingdom');
    expect(london.length).toBeLessThanOrEqual(12);
    expect(london.length).toBeGreaterThan(0);
    expect(london.every(place => place.country === 'GB')).toBe(true);
    for (const place of london) expect(validateCarLocationChoice(place)).toEqual(place);
  });
  it('keeps accented city names searchable without exposing provider identifiers', async () => {
    const results = await searchCarLocations('Sao Paulo');
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ city: 'São Paulo', country: 'BR' })]));
    expect(results.every(place => !('providerIds' in place))).toBe(true);
  });
  it('rejects tampered catalog bytes, stale versions and unknown identities', async () => {
    const bytes = await readFile(join(await carLocationDataPath(), 'catalog.json.gz'));
    bytes[30] = bytes[30]! ^ 1;
    expect(() => decodeCarCatalog(bytes)).toThrow(/integrity/);
    await expect(getCarCatalogPlace(airport.id, '0'.repeat(64))).rejects.toMatchObject({ status: 409 });
    await expect(getCarCatalogPlace('ourairports:0')).rejects.toThrow(/suggestions/);
    await expect(searchCarLocations('a'.repeat(101))).rejects.toThrow(/100/);
    expect(await searchCarLocations('a')).toEqual([]);
  });
  it('reconstructs timezone and geography while leaving resolution explicitly pending', async () => {
    const search = await carSearchIntent(input());
    expect(search.pickup).toMatchObject({ country: 'GB', timeZone: 'Europe/London', catalog: { id: airport.id, version: airport.version }, providerIds: {} });
    expect(() => validateCarSearch(search)).toThrow(/locations/);
    expect(validateCarSearch(search, new Date(), { allowUnresolvedProviders: true })).toEqual(search);
    expect(() => validateCarSearch({ ...search, pickup: { ...search.pickup, catalog: undefined } }, new Date(), { allowUnresolvedProviders: true })).toThrow(/locations/);
  });
  it.each(['country', 'timeZone', 'providerIds', 'providerNames', 'name'])('rejects client-supplied %s on a catalog choice', async field => {
    const value = input();
    await expect(carSearchIntent({ ...value, pickup: { ...value.pickup, [field]: 'forged' } })).rejects.toThrow(/server-managed/);
  });
  it('rejects executable metadata, forged protection and ambiguous local time in public intent', async () => {
    await expect(carSearchIntent({ ...input(), allowUnresolvedProviders: true })).rejects.toThrow(/Unsupported/);
    await expect(carSearchIntent({ ...input(), pickupAt: { ...input().pickupAt, instant: '2000-01-01T00:00:00Z' } })).rejects.toThrow(/server-managed/);
    await expect(carSearchIntent({ ...input(), sources: ['autoeurope'], extras: { protection: [{ source: 'autoeurope', productId: 'invented' }] } })).rejects.toThrow(/verified provider/);
    const year = new Date().getUTCFullYear() + 1;
    const lastSunday = new Date(Date.UTC(year, 10, 0)); lastSunday.setUTCDate(lastSunday.getUTCDate() - lastSunday.getUTCDay());
    await expect(carSearchIntent({ ...input(), pickupAt: { date: lastSunday.toISOString().slice(0, 10), time: '01:30' }, dropoffAt: { date: `${year}-11-01`, time: '11:00' } })).rejects.toThrow(/ambiguous/);
  });
  it('binds retry identity to the owner and semantic body rather than JSON property order', () => {
    const raw = input(), key = crypto.randomUUID(), actor = { userId: 'alice', isAdmin: false };
    const receipt = carSearchReceipt(raw, actor, key);
    expect(carSearchReceipt(Object.fromEntries(Object.entries(raw).reverse()), actor, key)).toEqual(receipt);
    expect(carSearchReceipt(raw, { ...actor, userId: 'bob' }, key).id).not.toBe(receipt.id);
    expect(carSearchReceipt({ ...raw, currency: 'USD' }, actor, key).requestHash).not.toBe(receipt.requestHash);
  });
  it('requires exact airport code, country and type independently of provider display names', async () => {
    const response = { data: [{ locations: [
      { location_id: 1, location_type_id: 1, name: 'London', city_name: 'London', country_code: 'CA', code: 'LHR' },
      { location_id: 2, location_type_id: 2, name: 'London', city_name: 'London', country_code: 'GB', code: 'LHR' },
      { location_id: 547, location_type_id: 1, name: 'London Heathrow Airport', city_name: 'London', country_code: 'GB', code: 'LHR' },
    ] }] };
    const suggestions = carLocationSuggestions(response, 'autoeurope');
    expect(await matchCarProviderLocation(airport, suggestions, 'autoeurope')).toEqual({ id: '547', name: 'London Heathrow Airport' });
    await expect(matchCarProviderLocation(airport, suggestions.slice(0, 2), 'autoeurope')).rejects.toThrow(/uniquely match/);
    await expect(matchCarProviderLocation(airport, [...suggestions, { ...suggestions[2]!, id: '999' }], 'autoeurope')).rejects.toThrow(/uniquely match/);
  });
  it('matches US airport state labels without relaxing country, airport type, code or uniqueness', async () => {
    const jfk = await getCarCatalogPlace('ourairports:3622');
    const raw = { placeID: 4812, place: 'New York International Airport Kennedy (JFK)', city: 'New York', country: 'USA - New York', location: 'airport' };
    const suggestions = carLocationSuggestions({ success: true, result: [raw] }, 'discovercars');
    expect(await matchCarProviderLocation(jfk, suggestions, 'discovercars')).toEqual({ id: '4812', name: raw.place });
    for (const override of [{ country: 'Canada' }, { country: 'USA - Unknown' }, { kind: 'city' }, { code: 'LGA' }]) {
      await expect(matchCarProviderLocation(jfk, [{ ...suggestions[0]!, ...override }], 'discovercars')).rejects.toThrow(/uniquely match/);
    }
    await expect(matchCarProviderLocation(airport, suggestions, 'discovercars')).rejects.toThrow(/uniquely match/);
    await expect(matchCarProviderLocation(jfk, [...suggestions, { ...suggestions[0]!, id: '999' }], 'discovercars')).rejects.toThrow(/uniquely match/);
  });
  it('retains US state evidence when matching a city', async () => {
    const city = await getCarCatalogPlace('geonames:5128581');
    const suggestion = { id: '4808', name: 'New York', city: 'New York', country: 'USA - New York', kind: 'city', code: null };
    expect(await matchCarProviderLocation(city, [suggestion], 'discovercars')).toEqual({ id: '4808', name: 'New York' });
    await expect(matchCarProviderLocation(city, [{ ...suggestion, country: 'USA - New Jersey' }], 'discovercars')).rejects.toThrow(/uniquely match/);
    await expect(matchCarProviderLocation({ ...city, country: 'CA' }, [suggestion], 'discovercars')).rejects.toThrow(/uniquely match/);
    for (const country of ['USA - Nebraska', 'USA - Wisconsin', 'United States of America (USA)']) {
      await expect(matchCarProviderLocation(city, [{ ...suggestion, country }], 'discovercars')).rejects.toThrow(/uniquely match/);
    }
    await expect(matchCarProviderLocation(city, [{ ...suggestion, country: 'US' }], 'autoeurope')).rejects.toThrow(/uniquely match/);
    const springfield = await getCarCatalogPlace('geonames:4224162');
    await expect(matchCarProviderLocation(springfield, [{ ...suggestion, name: 'Springfield', city: 'Springfield', country: 'USA - Georgia' }], 'discovercars')).rejects.toThrow(/uniquely match/);
  });
  it.each(['discovercars', 'autoeurope'] as const)('matches only a unique exact downtown area for %s and retains its full label', async source => {
    const city = await getCarCatalogPlace('geonames:5128581');
    const raw = source === 'discovercars'
      ? { success: true, result: [{ placeID: 4814, place: 'New York Downtown', city: 'New York', country: 'USA - New York', location: 'downtown' }] }
      : { data: [{ locations: [{ location_id: 85276786, location_type_id: 2, name: 'New York City Downtown', city_name: 'New York City', country_code: 'US', code: null }] }] };
    const suggestions = carLocationSuggestions(raw, source), candidate = suggestions[0]!;
    expect(await matchCarProviderLocation(city, suggestions, source)).toEqual({ id: candidate.id, name: candidate.name });
    for (const name of [`${candidate.city} North Downtown`, `${candidate.city} Airport`, `${candidate.city} Suburb`, 'Manhattan Downtown']) {
      await expect(matchCarProviderLocation(city, [{ ...candidate, name }], source)).rejects.toThrow(/uniquely match/);
    }
    await expect(matchCarProviderLocation(city, [candidate, { ...candidate, id: '999' }], source)).rejects.toThrow(/uniquely match/);
    await expect(matchCarProviderLocation(city, [candidate, { ...candidate, id: '998', name: candidate.city, kind: 'city' }], source)).rejects.toThrow(/uniquely match/);
    await expect(matchCarProviderLocation(airport, suggestions, source)).rejects.toThrow(/uniquely match/);
  });
  it('refuses a city name shared by multiple places in the same country', async () => {
    const springfield = (await searchCarLocations('Springfield US')).find(place => place.kind === 'city' && place.name === 'Springfield' && place.country === 'US');
    expect(springfield).toBeDefined();
    await expect(matchCarProviderLocation(springfield!, [{ id: '1', name: 'Springfield', city: 'Springfield', country: 'US', kind: 'city', code: null }], 'autoeurope')).rejects.toThrow(/uniquely match/);
  });
  it('rejects malformed or oversized provider suggestion lists', () => {
    expect(() => carLocationSuggestions({ success: false, result: [] }, 'discovercars')).toThrow(/invalid/);
    expect(() => carLocationSuggestions({ data: [{ locations: Array.from({ length: 1001 }, () => ({})) }] }, 'autoeurope')).toThrow(/large/);
  });
});
