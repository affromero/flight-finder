import { prisma } from '@/lib/prisma';
import type { Prisma, HotelTracker, HotelSearchRun } from '@/generated/prisma/client';
import { HotelError, validateHotelSearch, validateHotelOptions } from './domain';
import { assertHotelOwner, type HotelActor } from './access';
import type { HotelSearch, HotelSearchResult, HotelSelection, HotelTrackingOptions } from './types';

export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function trackerDto(row: HotelTracker) {
  const search = row.search as unknown as HotelSearch;
  return { id: row.id, userId: row.userId, hotelName: row.hotelName, search, selection: row.selection as unknown as HotelSelection, options: row.options as unknown as HotelTrackingOptions, active: row.active, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null, lastError: row.lastError, latestPrice: row.latestPrice === null ? null : Number(row.latestPrice), currency: search.currency };
}
export async function getHotelTracker(id: string, actor: HotelActor) {
  const row = await prisma.hotelTracker.findUnique({ where: { id } });
  assertHotelOwner(actor, row);
  if (!row) throw new HotelError('Hotel tracker not found', 404);
  return row;
}
export async function lockHotelTracker(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "HotelTracker" WHERE "id" = ${id} FOR UPDATE`;
  return tx.hotelTracker.findUnique({ where: { id } });
}
export async function createHotelSearch(raw: unknown, actor: HotelActor) {
  const search = validateHotelSearch(raw);
  return prisma.$transaction(async tx => {
    const count = await tx.hotelSearchRun.count({ where: { status: { in: ['queued', 'running'] }, userId: actor.userId } });
    if (count >= 3) throw new HotelError('Three hotel searches are already active; wait or cancel one', 429);
    return tx.hotelSearchRun.create({ data: { userId: actor.userId, request: json(search) } });
  }, { isolationLevel: 'Serializable' });
}
export async function createHotelTracker(raw: unknown, actor: HotelActor) {
  if (!raw || typeof raw !== 'object') throw new HotelError('Invalid tracker');
  const r = raw as Record<string, unknown>;
  if (typeof r.searchId !== 'string' || typeof r.offerId !== 'string') throw new HotelError('Choose a hotel from a completed search');
  const run = await prisma.hotelSearchRun.findUnique({ where: { id: r.searchId } });
  assertHotelOwner(actor, run);
  if (!run || !['success', 'partial'].includes(run.status)) throw new HotelError('Search is not ready');
  if (Date.now() - run.createdAt.getTime() > 86_400_000) throw new HotelError('Search expired; search again', 410);
  const result = run.result as unknown as HotelSearchResult;
  const offer = result.offers.find(o => o.id === r.offerId);
  if (!offer) throw new HotelError('Offer was not returned by this search');
  const options = validateHotelOptions(r);
  if (options.mode === 'room' && !offer.roomName) throw new HotelError('This source did not provide a room identity; choose best matching offer');
  const search = validateHotelSearch(run.request);
  search.sources = [offer.source];
  search.destination = offer.hotelName;
  // Search budgets choose results; a tracker retains above-target observations.
  search.filters.maxTotal = null;
  const selection: HotelSelection = { propertyId: offer.propertyId, source: offer.source, hotelName: offer.hotelName, propertyUrl: offer.propertyUrl, roomName: offer.roomName, rateName: offer.rateName, seller: offer.seller, refundable: offer.refundable, breakfast: offer.breakfast };
  if (offer.providerRateId) selection.providerRateId = offer.providerRateId;
  return prisma.hotelTracker.create({ data: { userId: actor.userId, hotelName: offer.hotelName, search: json(search), selection: json(selection), options: json(options) } });
}
export function refreshHotelTracker(id: string, actor: HotelActor): Promise<HotelSearchRun>;
export function refreshHotelTracker(id: string, actor: HotelActor, dueOnly: true): Promise<HotelSearchRun | null>;
export async function refreshHotelTracker(id: string, actor: HotelActor, dueOnly = false) {
  return prisma.$transaction(async tx => {
    const tracker = await lockHotelTracker(tx, id);
    assertHotelOwner(actor, tracker);
    if (!tracker) throw new HotelError('Hotel tracker not found', 404);
    if (dueOnly && (!tracker.active || tracker.nextCheckAt > new Date())) return null;
    validateHotelSearch(tracker.search);
    const existing = await tx.hotelSearchRun.findFirst({ where: { trackerId: id, status: { in: ['queued', 'running'] } } });
    if (existing) return existing;
    return tx.hotelSearchRun.create({ data: { userId: tracker.userId, trackerId: id, request: tracker.search as Prisma.InputJsonValue } });
  });
}
export async function editHotelTracker(id: string, raw: unknown, actor: HotelActor) {
  if (!raw || typeof raw !== 'object') throw new HotelError('Invalid update');
  const r = raw as Record<string, unknown>;
  const allowed = ['active', 'targetPrice', 'notifyLows', 'allowApproximateAlerts', 'scrapeInterval', 'userId'];
  if (Object.keys(r).some(k => !allowed.includes(k))) throw new HotelError('Unsupported update; create a new tracker to change stay criteria');
  if (r.active !== undefined && typeof r.active !== 'boolean') throw new HotelError('active must be a boolean');
  if (r.userId !== undefined) {
    if (!actor.isAdmin) throw new HotelError('Only administrators can reassign trackers', 403);
    if (typeof r.userId !== 'string' || !(await prisma.user.findUnique({ where: { id: r.userId } }))) throw new HotelError('Choose an existing user');
  }
  return prisma.$transaction(async tx => {
    const tracker = await lockHotelTracker(tx, id);
    assertHotelOwner(actor, tracker);
    if (!tracker) throw new HotelError('Hotel tracker not found', 404);
    const previous = tracker.options as unknown as HotelTrackingOptions;
    const options = validateHotelOptions({ ...previous, ...r });
    const eligibilityChanged = options.allowApproximateAlerts !== previous.allowApproximateAlerts;
    const rearmTarget = options.targetPrice !== previous.targetPrice || eligibilityChanged;
    const settingsChanged = rearmTarget || options.notifyLows !== previous.notifyLows;
    const busy = await tx.hotelSearchRun.count({ where: { trackerId: id, status: 'running' } });
    if (busy) throw new HotelError('Wait for the current check to finish before editing', 409);
    if (settingsChanged || r.active === false || r.userId !== undefined) await tx.hotelAlert.updateMany({ where: { trackerId: id, pending: true }, data: { pending: false } });
    if (r.active === false || r.userId !== undefined) await tx.hotelSearchRun.updateMany({ where: { trackerId: id, status: 'queued' }, data: { status: 'cancelled', completedAt: new Date() } });
    return tx.hotelTracker.update({ where: { id }, data: { options: json(options), ...(r.active !== undefined ? { active: r.active as boolean } : {}), ...(r.userId !== undefined ? { userId: r.userId as string } : {}), ...(rearmTarget ? { targetArmed: true } : {}), ...(eligibilityChanged ? { historicalLow: null } : {}), nextCheckAt: new Date() } });
  });
}
