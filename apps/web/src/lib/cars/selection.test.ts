import { describe, expect, it } from 'vitest';
import { carContractHash, carTrackerSearch, selectCarObservation } from './selection';
import { validateCarSearch } from './validation';
import type { CarEvidence, CarOffer, CarSearchReport } from './types';
import { CAR_IMPORT_URL } from '@/test/import-fixtures';

it('refreshes an imported rental using its verified contract instead of an expiring offer link', () => {
  const tracking = carTrackerSearch({ ...search, sourceUrl: CAR_IMPORT_URL });
  expect(tracking.sourceUrl).toBeUndefined();
  expect(tracking.pickupAt).toEqual(search.pickupAt);
  expect(tracking.driver).toEqual(search.driver);
});

const now = new Date('2026-09-06T12:01:00Z');
const location = { name: 'Example Airport', country: 'GB', timeZone: 'Europe/London', providerIds: { discovercars: '1712' } };
const search = validateCarSearch({ pickup: location, dropoff: location, pickupAt: { date: '2026-10-15', time: '11:00' }, dropoffAt: { date: '2026-10-18', time: '11:00' }, driver: { age: 35, licenceYears: 2, residenceCountry: 'GB' }, currency: 'USD', sources: ['discovercars'] }, new Date('2026-09-01'));
const evidence = <T>(value: T): CarEvidence<T> => ({ value, status: 'confirmed', text: 'Verified provider rental terms', sourceUrl: 'https://www.discovercars.com/offer/example', observedAt: '2026-09-06T12:00:00Z' });
function offer(minor = 10000, supplierId = 'supplier-1'): CarOffer {
  return {
    id: `quote-${supplierId}`, supplier: supplierId, bookingUrl: 'https://www.discovercars.com/offer/session', observedAt: '2026-09-06T12:00:00Z',
    contract: {
      source: 'discovercars', supplierId, pickupLocationId: '1712', dropoffLocationId: '1712', pickupStationId: 'terminal-1', dropoffStationId: 'terminal-1',
      pickupAt: search.pickupAt, dropoffAt: search.dropoffAt, driver: search.driver, additionalDrivers: [], currency: 'USD', vehicleClass: 'compact', transmission: 'automatic', seats: 5,
      model: 'Example car', modelGuaranteed: false, fuelPolicy: 'full_to_full', mileagePolicy: 'unlimited', cancellationPolicy: 'free_until_48h', coverageProductIds: ['cdw'], coverageTerms: 'Collision damage waiver with stated excess', rentalRequirements: '[]', extras: [],
    },
    available: evidence(true), requestVerified: evidence(true), driverEligible: evidence(true), requirements: [], requirementsComplete: evidence(true), mandatoryChargesComplete: evidence(true), taxesIncluded: evidence(true), unlimitedMileage: evidence(true), freeCancellation: evidence(true),
    total: evidence({ currency: 'USD', minor }), charges: [{ id: 'rental', label: 'Rental including taxes', kind: 'rental', payment: 'now', amount: evidence({ currency: 'USD', minor }) }],
    deposit: { ...evidence(null), status: 'unknown' }, excess: { ...evidence(null), status: 'unknown' }, extras: [],
  };
}
function report(offers: CarOffer[]): CarSearchReport {
  return { scope: 'checked_provider_offers', offers, candidates: [], errors: [], completed: 1, total: 1, successfulProviders: 1, providers: [{ source: 'discovercars', status: 'complete', checked: offers.length, discoveredVisible: 20, limit: 8, truncated: true }] };
}

describe('selection among checked rental offers', () => {
  it('chooses the lowest verified total without admitting a cheaper unconfirmed quote', () => {
    const incomplete = offer(100, 'unconfirmed'); incomplete.taxesIncluded.status = 'unknown';
    expect(selectCarObservation(report([offer(12000), incomplete, offer(10000, 'other')]), search, undefined, now)).toMatchObject({ status: 'matched', offer: { supplier: 'other' }, assessment: { total: { minor: 10000 } } });
  });
  it('finds a selected contract in a fresh session rather than replacing it with a cheaper similar car', () => {
    const original = offer(), fresh = offer(13000);
    fresh.id = 'new-session-quote'; fresh.bookingUrl = 'https://www.discovercars.com/offer/new-session'; fresh.contract.model = 'Another illustrative car';
    const selection = { source: 'discovercars' as const, contractHash: carContractHash(original.contract) };
    expect(selectCarObservation(report([offer(5000, 'other-supplier'), fresh]), search, selection, now)).toMatchObject({ status: 'matched', offer: { id: 'new-session-quote' }, assessment: { total: { minor: 13000 } } });
  });
  it('does not claim a selected contract is unavailable after a bounded miss', () => {
    const selection = { source: 'discovercars' as const, contractHash: carContractHash(offer().contract) };
    expect(selectCarObservation(report([offer(5000, 'other')]), search, selection, now)).toMatchObject({ status: 'not_found_in_checked_offers' });
  });
  it.each(['partial', 'failed', 'timed_out', 'blocked'] as const)('keeps a %s provider check inconclusive when no eligible selected observation exists', status => {
    const result = report([]); result.providers[0]!.status = status;
    expect(selectCarObservation(result, search, undefined, now)).toMatchObject({ status: 'inconclusive' });
  });
  it('retains an eligible observation when a later detail fails', () => {
    const result = report([offer()]); result.providers[0]!.status = 'partial';
    expect(selectCarObservation(result, search, undefined, now)).toMatchObject({ status: 'matched' });
  });
  it('keeps a missing requested provider inconclusive rather than treating it as completed', () => {
    expect(selectCarObservation(report([]), { ...search, sources: ['discovercars', 'autoeurope'] }, undefined, now)).toMatchObject({ status: 'inconclusive' });
  });
  it('retains above-target tracker prices while leaving the original discovery ceiling unchanged', () => {
    const discovery = { ...search, filters: { ...search.filters, maxTotal: { currency: 'USD', minor: 9000 } } };
    expect(selectCarObservation(report([offer()]), discovery, undefined, now)).toMatchObject({ status: 'no_eligible_checked_offers' });
    expect(selectCarObservation(report([offer()]), carTrackerSearch(discovery), undefined, now)).toMatchObject({ status: 'matched', assessment: { total: { minor: 10000 } } });
    expect(selectCarObservation(report([offer()]), discovery, { source: 'discovercars', contractHash: carContractHash(offer().contract) }, now)).toMatchObject({ status: 'matched', assessment: { total: { minor: 10000 } } });
    expect(discovery.filters.maxTotal?.minor).toBe(9000);
  });
  it('does not admit expired observations or a forged contract selector', () => {
    expect(selectCarObservation(report([offer()]), search, undefined, new Date('2026-09-06T13:00:00Z'))).toMatchObject({ status: 'no_eligible_checked_offers' });
    expect(() => selectCarObservation(report([offer()]), search, { source: 'discovercars', contractHash: 'not-a-hash' }, now)).toThrow(/selected rental/);
  });
});
