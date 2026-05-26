import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { authorizeMutation } from '@/lib/query-auth';
import { isAggregatorSource } from '@/lib/scraper/navigate';

const ALLOWED_INTERVALS = [1, 3, 6, 12, 24];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;

  const query = await prisma.query.findUnique({
    where: { id },
    select: { deleteToken: true, groupId: true, userId: true },
  });

  if (!query) return apiError('Tracker not found', 404);

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);

  // Group-cascading fields: applied to every sibling in the group via updateMany.
  const cascadeData: { scrapeInterval?: number | null; active?: boolean } = {};
  // Per-row fields: applied only to the single id. preferredAggregators is
  // intentionally NOT cascaded — different siblings in a flex group can sit on
  // different aggregators (e.g. one experimental, one default).
  const singleRowData: { preferredAggregators?: string[] } = {};

  if (body && Object.prototype.hasOwnProperty.call(body, 'scrapeInterval')) {
    let interval: number | null;
    if (body.scrapeInterval === null) {
      interval = null;
    } else {
      interval = Number(body.scrapeInterval);
      if (!ALLOWED_INTERVALS.includes(interval)) {
        return apiError(`scrapeInterval must be null or one of: ${ALLOWED_INTERVALS.join(', ')}`, 400);
      }
    }
    cascadeData.scrapeInterval = interval;
  }

  if (body && Object.prototype.hasOwnProperty.call(body, 'active')) {
    if (typeof body.active !== 'boolean') {
      return apiError('active must be a boolean', 400);
    }
    cascadeData.active = body.active;
  }

  if (body && Object.prototype.hasOwnProperty.call(body, 'preferredAggregators')) {
    if (!Array.isArray(body.preferredAggregators)) {
      return apiError('preferredAggregators must be an array of strings', 422);
    }
    for (const a of body.preferredAggregators) {
      if (!isAggregatorSource(a)) {
        return apiError(`preferredAggregators contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    singleRowData.preferredAggregators = body.preferredAggregators;
  }

  if (Object.keys(cascadeData).length === 0 && Object.keys(singleRowData).length === 0) {
    return apiError('No updatable fields supplied', 400);
  }

  const idsToUpdate = [id];
  if (query.groupId && Object.keys(cascadeData).length > 0) {
    const siblings = await prisma.query.findMany({
      where: { groupId: query.groupId, id: { not: id } },
      select: { id: true },
    });
    idsToUpdate.push(...siblings.map((s) => s.id));
  }

  if (Object.keys(cascadeData).length > 0) {
    await prisma.query.updateMany({
      where: { id: { in: idsToUpdate } },
      data: cascadeData,
    });
  }

  if (Object.keys(singleRowData).length > 0) {
    await prisma.query.update({
      where: { id },
      data: singleRowData,
    });
  }

  return apiSuccess({ ...cascadeData, ...singleRowData, updated: idsToUpdate.length });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;
  const groupDelete = body?.groupDelete === true;

  const query = await prisma.query.findUnique({
    where: { id },
    select: { deleteToken: true, groupId: true, userId: true },
  });

  if (!query) {
    return apiError('Tracker not found', 404);
  }

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);

  if (groupDelete && query.groupId) {
    const result = await prisma.query.deleteMany({ where: { groupId: query.groupId } });
    return apiSuccess({ deleted: true, groupDeleted: true, count: result.count });
  }

  await prisma.query.delete({ where: { id } });

  return apiSuccess({ deleted: true, groupDeleted: false });
}
