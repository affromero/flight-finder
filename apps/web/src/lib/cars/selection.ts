import { createHash } from 'node:crypto';
import { carContractIdentity, validateCarSelection } from './identity';
import { assessCarPrice, type CarPriceAssessment } from './pricing';
import { CarError, type CarContractSelection, type CarOffer, type CarSearch, type CarSearchReport } from './types';
export { validateCarSelection } from './identity';

/** Server-side stable identity; never uses a provider's expiring session URL. */
export function carContractHash(contract: unknown): string {
  return createHash('sha256').update(carContractIdentity(contract)).digest('hex');
}

/** A discovery ceiling must not hide later above-target observations from alerts. */
export function carTrackerSearch(search: CarSearch): CarSearch {
  const tracking = { ...search, filters: { ...search.filters, maxTotal: null } };
  delete tracking.protectionRecheck;
  delete tracking.sourceUrl;
  return tracking;
}

export type CarObservationSelection =
  | { status: 'matched'; offer: CarOffer; assessment: CarPriceAssessment; contractHash: string }
  | { status: 'not_found_in_checked_offers' | 'no_eligible_checked_offers' | 'inconclusive'; reasons: string[] };

/** Selects only among verified observations; a bounded miss never proves unavailability. */
export function selectCarObservation(report: CarSearchReport, search: CarSearch, selection?: CarContractSelection, now = new Date()): CarObservationSelection {
  if (selection) {
    validateCarSelection(selection);
    if (!search.sources.includes(selection.source)) throw new CarError('Selected contract provider is not included in this rental search');
    search = carTrackerSearch(search);
  }
  const observations = report.offers.flatMap(offer => {
    const assessment = assessCarPrice(offer, search, now);
    if (!assessment.eligible || !assessment.total) return [];
    const contractHash = carContractHash(offer.contract);
    if (selection && (offer.contract.source !== selection.source || contractHash !== selection.contractHash)) return [];
    return [{ offer, assessment, contractHash }];
  });
  observations.sort((left, right) => left.assessment.total!.minor - right.assessment.total!.minor || left.contractHash.localeCompare(right.contractHash) || left.offer.id.localeCompare(right.offer.id));
  const best = observations[0];
  if (best) return { status: 'matched', ...best };
  const sources = selection ? [selection.source] : search.sources;
  if (sources.some(source => report.providers.find(provider => provider.source === source)?.status !== 'complete')) {
    return { status: 'inconclusive', reasons: ['The provider check did not complete; no price or availability conclusion was made'] };
  }
  return selection
    ? { status: 'not_found_in_checked_offers', reasons: ['The selected rental contract was not verified among the checked offers; this does not establish that it is unavailable'] }
    : { status: 'no_eligible_checked_offers', reasons: ['None of the checked offers has a confirmed total matching the requested rental and filters'] };
}
