import { describe, expect, it } from 'vitest';
import { carOfferFixture, carReportFixture, carSearchFixture } from '@/test/car-fixtures';
import { validateCarReport } from './report';

describe('rental report validation at persistence boundaries', () => {
  it('preserves the one-offer scope of an imported rental', () => {
    const report = carReportFixture();
    report.providers[0]!.limit = 1;
    expect(validateCarReport(report, carSearchFixture().sources)).toEqual(report);
  });
  it('retains verified quotes and coherent progress while removing unrecognized fields', () => {
    const report = carReportFixture();
    expect(validateCarReport({ ...report, unsafePayload: 'discard' }, carSearchFixture().sources)).toEqual(report);
  });
  it.each([
    ['duplicate quotes', (r: ReturnType<typeof carReportFixture>) => { r.offers.push(r.offers[0]!); }],
    ['unrequested provider', (r: ReturnType<typeof carReportFixture>) => { r.offers[0]!.contract.source = 'unrequested' as 'discovercars'; }],
    ['impossible progress', (r: ReturnType<typeof carReportFixture>) => { r.providers[0]!.checked = 0; }],
    ['future observation', (r: ReturnType<typeof carReportFixture>) => { r.offers[0]!.observedAt = new Date(Date.now() + 60_000).toISOString(); }],
    ['wrong completion count', (r: ReturnType<typeof carReportFixture>) => { r.completed = 0; }],
    ['hidden truncation', (r: ReturnType<typeof carReportFixture>) => { r.providers[0]!.discoveredVisible = 10; }],
    ['omitted checked observations', (r: ReturnType<typeof carReportFixture>) => { r.providers[0]!.checked = 8; r.providers[0]!.discoveredVisible = 8; }],
    ['unchecked discovered offers', (r: ReturnType<typeof carReportFixture>) => { r.providers[0]!.discoveredVisible = 2; }],
    ['errors in a supposedly complete provider', (r: ReturnType<typeof carReportFixture>) => { r.errors.push({ source: 'discovercars', message: 'Detail failed' }); }],
  ])('rejects %s instead of dropping malformed data', (label, change) => {
    const report = carReportFixture(); change(report);
    expect(() => validateCarReport(report, carSearchFixture().sources), label).toThrow();
  });
  it('preserves explicit incomplete candidates without promoting their advertised price', () => {
    const offer = carOfferFixture();
    const report = carReportFixture([]);
    report.providers[0]!.checked = 1; report.providers[0]!.discoveredVisible = 1;
    report.candidates.push({ source: 'discovercars', supplier: offer.supplier, model: offer.contract.model, bookingUrl: offer.bookingUrl, observedAt: offer.observedAt, advertisedTotal: { ...offer.total, status: 'estimated' }, requirements: [], reasons: ['Unconfirmed mandatory fee'] });
    const validated = validateCarReport(report, carSearchFixture().sources);
    expect(validated.offers).toEqual([]);
    expect(validated.candidates[0]).toMatchObject({ advertisedTotal: { status: 'estimated' }, reasons: ['Unconfirmed mandatory fee'] });
  });
});
