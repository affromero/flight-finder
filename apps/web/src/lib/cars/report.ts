import { carInteger, carRecord, carText } from './validation';
import { carEvidence, carObservationTime, carProviderUrl, validateCarOffer, validateCarRequirements } from './offer-validation';
import { validateCarMoney } from './money';
import { CAR_SOURCES, CarError, type CarCandidate, type CarProviderProgress, type CarSearchReport, type CarSource } from './types';
import { validateCarProtectionDiscovery } from './protection-discovery';

function list(raw: unknown, limit: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > limit) throw new CarError('Invalid rental report list');
  return raw;
}
function provider(raw: unknown, sources: CarSource[]): CarSource {
  const source = CAR_SOURCES.find(source => source === raw);
  if (!source || !sources.includes(source)) throw new CarError('Rental report contains an unrequested provider');
  return source;
}
function candidate(raw: unknown, sources: CarSource[], now: Date): CarCandidate {
  const r = carRecord(raw), source = provider(r.source, sources);
  const observedAt = carObservationTime(r.observedAt, now);
  const reasons = list(r.reasons, 30).map(reason => carText(reason, 16000, 'incomplete quote reason'));
  if (!reasons.length) throw new CarError('Incomplete quote must explain its missing evidence');
  return {
    source, observedAt, bookingUrl: carProviderUrl(r.bookingUrl, source),
    supplier: r.supplier === null ? null : carText(r.supplier, 200, 'supplier'), model: r.model === null ? null : carText(r.model, 200, 'vehicle model'),
    advertisedTotal: r.advertisedTotal === null ? null : carEvidence(r.advertisedTotal, source, observedAt, validateCarMoney),
    requirements: validateCarRequirements(r.requirements, source, observedAt), reasons,
  };
}

/** Validate stored reports again; malformed siblings cannot be silently dropped. */
export function validateCarReport(raw: unknown, sources: CarSource[], now = new Date()): CarSearchReport {
  const r = carRecord(raw);
  if (r.scope !== 'checked_provider_offers' || r.total !== sources.length) throw new CarError('Rental report scope does not match its request');
  const providers: CarProviderProgress[] = list(r.providers, sources.length).map((value, index) => {
    const p = carRecord(value), source = provider(p.source, sources);
    if (source !== sources[index]) throw new CarError('Rental report changed provider preference order');
    const status = (['running', 'complete', 'partial', 'failed', 'timed_out', 'blocked', 'cancelled'] as const).find(status => status === p.status);
    if (!status || (p.limit !== 8 && p.limit !== 1) || typeof p.truncated !== 'boolean') throw new CarError('Invalid rental provider progress');
    const limit = p.limit;
    const checked = carInteger(p.checked, 0, limit, 'Checked offers'), discoveredVisible = carInteger(p.discoveredVisible, checked, 10000, 'Visible offers');
    if (p.truncated !== (discoveredVisible > limit)) throw new CarError('Rental report has inconsistent scan limits');
    return { source, status, checked, discoveredVisible, limit, truncated: p.truncated };
  });
  const offers = list(r.offers, 16).map(value => validateCarOffer(value, now));
  if (new Set(offers.map(offer => offer.id)).size !== offers.length) throw new CarError('Rental report contains duplicate quotes');
  offers.forEach(offer => provider(offer.contract.source, sources));
  const candidates = list(r.candidates, 16).map(value => candidate(value, sources, now));
  const errors = list(r.errors, 32).map(value => {
    const error = carRecord(value);
    return { source: provider(error.source, sources), message: carText(error.message, 16000, 'provider error') };
  });
  for (const source of sources) {
    const observations = offers.filter(offer => offer.contract.source === source).length + candidates.filter(candidate => candidate.source === source).length;
    const progress = providers.find(provider => provider.source === source);
    if (observations > (progress?.checked ?? 0)) throw new CarError('Rental report observations exceed checked offers');
    if (progress?.status === 'complete' && (progress.checked !== Math.min(progress.discoveredVisible, progress.limit) || observations !== progress.checked || errors.some(error => error.source === source))) throw new CarError('Complete rental provider report has missing observations or errors');
  }
  const finished = providers.filter(provider => provider.status !== 'running');
  const successfulProviders = finished.filter(provider => provider.status === 'complete' || offers.some(offer => offer.contract.source === provider.source) || candidates.some(candidate => candidate.source === provider.source)).length;
  if (r.completed !== finished.length || r.successfulProviders !== successfulProviders) throw new CarError('Rental report completion counts are inconsistent');
  const protection = r.protection === undefined ? undefined : validateCarProtectionDiscovery(r.protection, offers, now);
  for (const entry of protection ?? []) {
    const source = offers.find(offer => offer.id === entry.offerId)!.contract.source;
    if (entry.status === 'failed' && (providers.find(provider => provider.source === source)?.status === 'complete'
      || !errors.some(error => error.source === source && error.message === entry.error))) throw new CarError('Protection discovery failure is missing from provider progress');
  }
  return { scope: 'checked_provider_offers', offers, candidates, errors, providers, completed: finished.length, total: sources.length, successfulProviders,
    ...(protection === undefined ? {} : { protection }) };
}
