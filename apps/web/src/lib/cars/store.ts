import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { Prisma, type CarTracker } from '@/generated/prisma/client';
import { cancelTravelJob, enqueueTravelJob, lockTravelResource } from '../travel/jobs';
import { assertCarOwner, type CarActor } from './access';
import { carInteger, carRecord, carText, validateCarOptions, validateCarSearch } from './validation';
import { validateCarOffer } from './offer-validation';
import { assessCarPrice, assessCarProtectionReview } from './pricing';
import { carContractHash, carTrackerSearch } from './selection';
import { CarError, type CarSearch } from './types';
import { carCreationIntent, carRefreshIntent } from './creation';
import { validateCarTrackerView } from './tracker-view';
import { carSearchIntent, carSearchReceipt } from './search-input';
import { assertCarProtectionRecheck } from './protection-recheck';
import { validateCarReport } from './report';
import { carProtectionInput } from './creation-input';

export const carJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function carMinorNumber(value: bigint | null): number | null {
  if (value === null) return null;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CarError('Stored rental amount is outside the supported range', 500);
  return Number(value);
}

export function carTrackerDto(row: CarTracker) {
  return validateCarTrackerView({
    id: row.id, userId: row.userId, label: row.label, search: row.search, selection: row.selection,
    options: { mode: row.mode, target: row.targetMinor === null ? null : { currency: row.currency, minor: carMinorNumber(row.targetMinor) }, notifyLows: row.notifyLows, scrapeInterval: row.scrapeInterval }, active: row.active, revision: row.revision,
    latestPriceMinor: carMinorNumber(row.latestPriceMinor), historicalLowMinor: carMinorNumber(row.historicalLowMinor), currency: row.currency,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    nextCheckAt: row.nextCheckAt.toISOString(), lastError: row.lastError,
  });
}

export async function lockCarTracker(tx: Prisma.TransactionClient, id: string, actor: CarActor): Promise<CarTracker> {
  await lockTravelResource(tx, 'car_search');
  const rows = await tx.$queryRaw<CarTracker[]>`SELECT * FROM "CarTracker" WHERE id = ${id} FOR UPDATE`;
  const row = rows[0] ?? null;
  assertCarOwner(actor, row);
  return row;
}

async function checkQuota(tx: Prisma.TransactionClient, userId: string | null): Promise<void> {
  const count = await tx.carSearchRun.count({ where: { userId, status: { in: ['queued', 'running'] } } });
  if (count >= 3) throw new CarError('Three car searches are already active; wait or cancel one', 429);
}

async function queueSearch(tx: Prisma.TransactionClient, search: CarSearch, userId: string | null, tracker?: CarTracker) {
  await checkQuota(tx, userId);
  const run = await tx.carSearchRun.create({ data: { userId, request: carJson(search), ...(tracker ? { trackerId: tracker.id, trackerRevision: tracker.revision } : {}) } });
  await enqueueTravelJob({ kind: 'car_search', carRunId: run.id, userId }, tx);
  return run;
}

/** Internal input must come from server-vetted geography before HTTP exposure. */
export async function createCarSearch(raw: unknown, actor: CarActor) {
  const search = validateCarSearch(raw);
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    return queueSearch(tx, search, actor.userId);
  });
}

export async function createCarCatalogSearch(raw: unknown, actor: CarActor, requestKey: unknown) {
  const receipt = carSearchReceipt(raw, actor, requestKey);
  const previous = await prisma.carSearchCreation.findUnique({ where: { id: receipt.id }, include: { run: true } });
  if (previous) {
    if (previous.requestHash !== receipt.requestHash) throw new CarError('This search key was already used for different rental criteria', 409);
    if (!previous.run) throw new CarError('This search was removed; retrying will not recreate it', 410);
    assertCarOwner(actor, previous.run);
    return previous.run;
  }
  const search = await carSearchIntent(raw);
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    const existing = await tx.carSearchCreation.findUnique({ where: { id: receipt.id }, include: { run: true } });
    if (existing) {
      if (existing.requestHash !== receipt.requestHash) throw new CarError('This search key was already used for different rental criteria', 409);
      if (!existing.run) throw new CarError('This search was removed; retrying will not recreate it', 410);
      assertCarOwner(actor, existing.run);
      return existing.run;
    }
    const run = await queueSearch(tx, search, actor.userId);
    await tx.carSearchCreation.create({ data: { ...receipt, userId: actor.userId, runId: run.id } });
    return run;
  });
}

export async function createCarProtectionRecheck(searchId: string, raw: unknown, actor: CarActor, requestKey: unknown) {
  const { offerId, choiceId } = carProtectionInput(raw);
  const receipt = carSearchReceipt({ operation: 'protection-recheck-v1', searchId, offerId, choiceId }, actor, requestKey);
  receipt.requestHash = createHash('sha256').update('protection-recheck-v1\0').update(receipt.requestHash).digest('hex');
  const owner = { ...actor, isAdmin: false };
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    const previous = await tx.carSearchCreation.findUnique({ where: { id: receipt.id }, include: { run: true } });
    if (previous) {
      if (previous.requestHash !== receipt.requestHash) throw new CarError('This search key was already used for a different request', 409);
      if (!previous.run) throw new CarError('This search was removed; retrying will not recreate it', 410);
      assertCarOwner(owner, previous.run);
      return previous.run;
    }
    await tx.$queryRaw`SELECT id FROM "CarSearchRun" WHERE id = ${searchId} FOR UPDATE`;
    const parent = await tx.carSearchRun.findUnique({ where: { id: searchId } });
    assertCarOwner(owner, parent);
    if (parent.trackingClosed) throw new CarError('New tracking from this search is permanently closed', 410);
    if (parent.trackerId !== null || !['success', 'partial'].includes(parent.status) || !parent.completedAt) throw new CarError('Choose protection from a completed standalone rental search', 409);
    const search = validateCarSearch(parent.request, new Date(), { allowUnresolvedProviders: true });
    if (search.extras.protection.length || search.protectionRecheck) throw new CarError('Choose protection from an original base rental search', 409);
    const report = validateCarReport(parent.result, search.sources, parent.completedAt);
    const offer = report.offers.find(offer => offer.id === offerId);
    const discovery = report.protection?.find(entry => entry.offerId === offerId && entry.status === 'complete');
    const choice = discovery?.choices.find(choice => choice.id === choiceId);
    if (!offer || !choice) throw new CarError('Choose a verified protection option returned for this rental');
    if (!assessCarProtectionReview(offer, search, parent.completedAt).allowed) throw new CarError('Protection review requires a verified base rental and itemized selected options', 409);
    const recheck = validateCarSearch({ ...search, sources: [choice.source],
      extras: { ...search.extras, protection: [{ source: choice.source, productId: choice.productId }] },
      protectionRecheck: { searchId, offerId, choiceId, baseContractHash: carContractHash(offer.contract), baseCoverageTerms: offer.contract.coverageTerms },
    }, new Date(), { allowUnresolvedProviders: true });
    const run = await queueSearch(tx, recheck, actor.userId);
    await tx.carSearchCreation.create({ data: { ...receipt, userId: actor.userId, runId: run.id } });
    return run;
  });
}

export async function getCarTracker(id: string, actor: CarActor) {
  const row = await prisma.carTracker.findUnique({ where: { id } });
  assertCarOwner(actor, row);
  return row;
}

export async function getCarSearch(id: string, actor: CarActor) {
  const row = await prisma.carSearchRun.findUnique({ where: { id } });
  assertCarOwner(actor, row);
  return row;
}

export async function closeCarSearchTracking(id: string, actor: CarActor) {
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    await tx.$queryRaw`SELECT id FROM "CarSearchRun" WHERE id = ${id} FOR UPDATE`;
    const run = await tx.carSearchRun.findUnique({ where: { id } });
    assertCarOwner(actor, run);
    if (run.trackerId !== null || !['success', 'partial'].includes(run.status) || !run.completedAt) {
      throw new CarError('Only completed standalone rental searches can close tracking', 409);
    }
    if (run.trackingClosed) return run;
    return tx.carSearchRun.update({ where: { id }, data: { trackingClosed: true } });
  });
}

export async function createCarTracker(raw: unknown, actor: CarActor, requestKey: unknown = randomUUID()) {
  const intent = carCreationIntent(raw, actor, requestKey);
  const { searchId, offerId } = intent;
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    const receipt = await tx.carTrackerCreation.findUnique({ where: { id: intent.id }, include: { tracker: true } });
    if (receipt) {
      if (receipt.requestHash !== intent.requestHash) throw new CarError('This creation key was already used for different rental settings', 409);
      if (!receipt.tracker) throw new CarError('This tracker was deleted; retrying will not recreate it', 410);
      assertCarOwner(actor, receipt.tracker);
      return receipt.tracker;
    }
    await tx.$queryRaw`SELECT id FROM "CarSearchRun" WHERE id = ${searchId} FOR UPDATE`;
    const run = await tx.carSearchRun.findUnique({ where: { id: searchId } });
    assertCarOwner(actor, run);
    if (run.trackingClosed) throw new CarError('New tracking from this search is permanently closed; existing trackers are unchanged', 410);
    if (!['success', 'partial'].includes(run.status) || !run.completedAt) throw new CarError('Choose a quote from a completed car search', 409);
    const search = validateCarSearch(run.request, new Date(), { allowUnresolvedProviders: true });
    const result = carRecord(run.result);
    if (!Array.isArray(result.offers) || result.offers.length > 16) throw new CarError('Stored rental results are invalid', 500);
    const offers = result.offers.map(value => validateCarOffer(value)).filter(offer => offer.id === offerId);
    if (offers.length !== 1) throw new CarError('Choose a quote returned by this search');
    const offer = offers[0]!;
    assertCarProtectionRecheck(offer, search);
    validateCarSearch({ ...search, sources: [offer.contract.source], extras: { ...search.extras, protection: search.extras.protection.filter(product => product.source === offer.contract.source) } });
    const assessment = assessCarPrice(offer, search);
    if (!assessment.eligible) throw new CarError(`This quote cannot be tracked: ${assessment.reasons.join('; ')}`, 409);
    const options = validateCarOptions(intent.options, search.currency);
    if (search.sourceUrl && options.mode !== 'contract') throw new CarError('Track the selected contract for an imported rental', 400);
    const selection = options.mode === 'contract' ? { source: offer.contract.source, contractHash: carContractHash(offer.contract) } : null;
    const trackingSearch = carTrackerSearch(search);
    const tracker = await tx.carTracker.create({ data: {
      userId: run.userId, label: intent.label ?? `${search.pickup.name} → ${search.dropoff.name}`,
      search: carJson(trackingSearch), selection: selection ? carJson(selection) : Prisma.DbNull, mode: options.mode, currency: search.currency,
      targetMinor: options.target?.minor ?? null, notifyLows: options.notifyLows, scrapeInterval: options.scrapeInterval,
    } });
    await queueSearch(tx, trackingSearch, tracker.userId, tracker);
    await tx.carTrackerCreation.create({ data: { id: intent.id, requestHash: intent.requestHash, userId: actor.userId, trackerId: tracker.id } });
    return tracker;
  });
}

export async function refreshCarTracker(id: string, actor: CarActor, dueOnly = false, manual?: { key: unknown; revision: number }) {
  const intent = manual ? carRefreshIntent(id, manual.revision, actor, manual.key) : null;
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    const receipt = intent ? await tx.carRefreshRequest.findUnique({ where: { id: intent.id }, include: { run: true } }) : null;
    if (receipt && receipt.requestHash !== intent!.requestHash) throw new CarError('This refresh key was already used for another tracker or revision', 409);
    if (receipt && !(await tx.carTracker.findUnique({ where: { id } }))) throw new CarError('This tracker was deleted; retrying will not recreate its check', 410);
    const tracker = await lockCarTracker(tx, id, actor);
    if (receipt) {
      if (!receipt.run) throw new CarError('This check was removed; retrying will not recreate it', 410);
      if (receipt.run.trackerId !== tracker.id) throw new CarError('Stored refresh receipt does not match this tracker', 500);
      return receipt.run;
    }
    if (manual) assertCarRevision(tracker, manual.revision);
    if (dueOnly && (!tracker.active || tracker.nextCheckAt > new Date())) return null;
    if (!tracker.active) throw new CarError('Resume this car tracker before refreshing', 409);
    const existing = await tx.carSearchRun.findFirst({ where: { trackerId: id, status: { in: ['queued', 'running'] } } });
    const run = existing ?? await queueSearch(tx, carTrackerSearch(validateCarSearch(tracker.search, new Date(), { allowUnresolvedProviders: true })), tracker.userId, tracker);
    if (intent) await tx.carRefreshRequest.create({ data: { ...intent, userId: actor.userId, runId: run.id } });
    return run;
  });
}

async function cancelTrackerWork(tx: Prisma.TransactionClient, id: string, reason: string): Promise<void> {
  const runs = await tx.carSearchRun.findMany({ where: { trackerId: id, status: { in: ['queued', 'running'] } }, include: { travelJob: true } });
  for (const run of runs) {
    if (run.travelJob) await cancelTravelJob(run.travelJob.id, null, true, tx);
    await tx.carSearchRun.update({ where: { id: run.id }, data: { status: 'cancelled', error: reason, completedAt: new Date() } });
  }
  await tx.travelAlertDelivery.updateMany({ where: { carTrackerId: id, pending: true }, data: { pending: false, lastError: reason } });
}

export async function editCarTracker(id: string, raw: unknown, actor: CarActor, expectedRevision?: number) {
  const input = carRecord(raw);
  const allowed = ['active', 'target', 'notifyLows', 'scrapeInterval', 'userId', 'label'];
  if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) throw new CarError('Unsupported update; create a new tracker to change rental criteria');
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new CarError('active must be a boolean');
  if (input.userId !== undefined && !actor.isAdmin) throw new CarError('Only administrators can reassign car trackers', 403);
  return prisma.$transaction(async tx => {
    const tracker = await lockCarTracker(tx, id, actor);
    assertCarRevision(tracker, expectedRevision);
    const previous = carTrackerDto(tracker);
    const options = validateCarOptions({ ...previous.options, ...input }, tracker.currency);
    const userId = input.userId === undefined ? tracker.userId : carText(input.userId, 200, 'tracker owner');
    if (input.userId !== undefined && !(await tx.user.findUnique({ where: { id: userId! } }))) throw new CarError('Choose an existing user');
    const label = input.label === undefined ? tracker.label : carText(input.label, 250, 'tracker label');
    const targetChanged = options.target?.minor !== previous.options.target?.minor;
    await cancelTrackerWork(tx, id, 'Car tracker settings changed; the previous check was cancelled');
    return tx.carTracker.update({ where: { id }, data: {
      userId, label, revision: { increment: 1 }, active: input.active === undefined ? tracker.active : input.active as boolean,
      targetMinor: options.target?.minor ?? null, notifyLows: options.notifyLows, scrapeInterval: options.scrapeInterval,
      targetArmed: targetChanged ? true : tracker.targetArmed, nextCheckAt: new Date(),
    } });
  });
}

export async function cancelCarSearch(id: string, actor: CarActor) {
  return prisma.$transaction(async tx => {
    await lockTravelResource(tx, 'car_search');
    await tx.$queryRaw`SELECT id FROM "CarSearchRun" WHERE id = ${id} FOR UPDATE`;
    const run = await tx.carSearchRun.findUnique({ where: { id }, include: { travelJob: true } });
    assertCarOwner(actor, run);
    if (!['queued', 'running'].includes(run.status)) return run;
    if (run.travelJob) await cancelTravelJob(run.travelJob.id, null, true, tx);
    return tx.carSearchRun.update({ where: { id }, data: { status: 'cancelled', error: 'Car search cancelled', completedAt: new Date() } });
  });
}

function assertCarRevision(tracker: CarTracker, expectedRevision: number | undefined) {
  if (expectedRevision === undefined) return;
  carInteger(expectedRevision, 0, 2147483647, 'Tracker revision');
  if (tracker.revision !== expectedRevision) throw new CarError('Rental settings changed; refresh before trying this action again', 412);
}

export async function deleteCarTracker(id: string, actor: CarActor, expectedRevision?: number): Promise<void> {
  await prisma.$transaction(async tx => {
    const tracker = await lockCarTracker(tx, id, actor);
    assertCarRevision(tracker, expectedRevision);
    await cancelTrackerWork(tx, id, 'Car tracker deleted');
    await tx.carTracker.delete({ where: { id } });
  });
}

export async function listCarTrackers(actor: CarActor, limit = 100, admin = false) {
  if (admin && !actor.isAdmin) throw new CarError('Administrator access required', 403);
  carInteger(limit, 1, 100, 'Tracker page size');
  const rows = await prisma.carTracker.findMany({ where: admin || actor.userId === null ? {} : { userId: actor.userId }, orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map(carTrackerDto);
}
