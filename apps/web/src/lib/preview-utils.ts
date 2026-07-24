import { expandContinuousRangeToDates } from '@/lib/scraper/scrape-dates';

const PREVIEW_MAX_DATES = 7;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Google Flights preview often stalls beyond ~9 months out. */
export const PREVIEW_MAX_FUTURE_DAYS = 270;
/** Show a UI warning when dates are far enough out that Google often stalls. */
export const PREVIEW_FAR_FUTURE_WARN_DAYS = 120;

/** Warn in the UI when a preview would fan out to this many scrapes. */
export const PREVIEW_COMBO_WARN_THRESHOLD = 8;

export const UNEQUAL_MULTI_DATE_ERROR =
  'Unequal multi-date outbound and return lists are not supported. Use a single outbound or return date, or matching-length lists.';

export interface PreviewDatePair {
  outboundDate: string;
  returnDate: string;
}

export interface PreviewDateFields {
  dateFrom: string;
  dateTo: string;
  tripType: string;
  outboundDates?: string[];
  returnDates?: string[];
}

/**
 * Build outbound/return date pairs for preview scraping.
 *
 * Policy:
 * - one-way: enumerated outs, or expand continuous range (capped)
 * - round-trip 1×N / N×1: broadcast the singleton leg (parser often returns this)
 * - equal lengths: zip by index
 * - unequal multi×multi: reject (avoids surprise cartesian explosion under the combo cap)
 */
export function buildPreviewDatePairs(
  outboundDates: string[] | undefined,
  returnDates: string[] | undefined,
  dateFrom: string,
  dateTo: string,
  isOneWay: boolean,
): PreviewDatePair[] {
  if (isOneWay) {
    const outbound = outboundDates ?? expandContinuousRangeToDates(dateFrom, dateTo, PREVIEW_MAX_DATES);
    return outbound.map((outboundDate) => ({ outboundDate, returnDate: outboundDate }));
  }

  const outbound = outboundDates?.length ? outboundDates : [dateFrom];
  const returns = returnDates?.length ? returnDates : [dateTo];

  if (outbound.length === 1) {
    return returns.map((returnDate) => ({ outboundDate: outbound[0]!, returnDate }));
  }
  if (returns.length === 1) {
    return outbound.map((outboundDate) => ({ outboundDate, returnDate: returns[0]! }));
  }
  if (outbound.length === returns.length) {
    return outbound.map((outboundDate, i) => ({ outboundDate, returnDate: returns[i]! }));
  }

  throw new Error(UNEQUAL_MULTI_DATE_ERROR);
}

export function countPreviewTasks(
  originsCount: number,
  destinationsCount: number,
  fields: PreviewDateFields,
): number {
  const isOneWay = fields.tripType === 'one_way';
  const datePairs = buildPreviewDatePairs(
    fields.outboundDates,
    fields.returnDates,
    fields.dateFrom,
    fields.dateTo,
    isOneWay,
  );
  return originsCount * destinationsCount * datePairs.length;
}

export function farthestPreviewDate(fields: PreviewDateFields): Date {
  const isOneWay = fields.tripType === 'one_way';
  const datePairs = buildPreviewDatePairs(
    fields.outboundDates,
    fields.returnDates,
    fields.dateFrom,
    fields.dateTo,
    isOneWay,
  );
  const allDates = datePairs.flatMap((pair) =>
    isOneWay ? [pair.outboundDate] : [pair.outboundDate, pair.returnDate],
  );
  if (allDates.length === 0) {
    return new Date(fields.dateTo + 'T00:00:00Z');
  }
  const sorted = [...allDates].sort();
  return new Date(sorted[sorted.length - 1]! + 'T00:00:00Z');
}

export function daysUntilPreviewDate(date: Date, now = new Date()): number {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.ceil((targetUtc - todayUtc) / MS_PER_DAY);
}

export function isPreviewTooFarInFuture(fields: PreviewDateFields, now = new Date()): boolean {
  return daysUntilPreviewDate(farthestPreviewDate(fields), now) > PREVIEW_MAX_FUTURE_DAYS;
}

export function isPreviewFarFutureWarn(fields: PreviewDateFields, now = new Date()): boolean {
  return daysUntilPreviewDate(farthestPreviewDate(fields), now) > PREVIEW_FAR_FUTURE_WARN_DAYS;
}

export function previewTooFarInFutureMessage(maxDays = PREVIEW_MAX_FUTURE_DAYS): string {
  const months = Math.round(maxDays / 30);
  return `Preview searches more than ${months} months out often fail on Google Flights. Pick nearer dates or fewer options.`;
}
