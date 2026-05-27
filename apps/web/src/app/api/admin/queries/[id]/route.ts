import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';
import { isAggregatorSource } from '@/lib/scraper/navigate';

// Fields that cascade across a query's group when groupId is set. userId and
// preferredAggregators stay single-row because they should be settable per
// sibling without affecting the rest of a flex group.
const GROUP_CASCADING_FIELDS = new Set(['active', 'scrapeInterval', 'maxDurationHours']);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const existing = await prisma.query.findUnique({ where: { id }, select: { groupId: true } });
  if (!existing) return apiError('Query not found', 404);

  const data: Record<string, unknown> = {};

  if (typeof body.active === 'boolean') data.active = body.active;
  if (body.scrapeInterval === null) {
    data.scrapeInterval = null;
  } else if (typeof body.scrapeInterval === 'number' && [1, 3, 6, 12, 24].includes(body.scrapeInterval)) {
    data.scrapeInterval = body.scrapeInterval;
  }
  if (body.maxDurationHours === null) {
    data.maxDurationHours = null;
  } else if (typeof body.maxDurationHours === 'number' && Number.isInteger(body.maxDurationHours) && body.maxDurationHours >= 1 && body.maxDurationHours <= 48) {
    data.maxDurationHours = body.maxDurationHours;
  }
  if (body.userId === null) {
    data.userId = null;
  } else if (typeof body.userId === 'string' && body.userId.length > 0) {
    const target = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!target) return apiError(`User not found: ${body.userId}`, 400);
    data.userId = body.userId;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'label')) {
    if (body.label === null) {
      data.label = null;
    } else if (typeof body.label === 'string') {
      const trimmed = body.label.trim();
      if (trimmed.length > 60) {
        return apiError('label must be 60 characters or fewer', 400);
      }
      data.label = trimmed || null;
    } else {
      return apiError('label must be a string or null', 400);
    }
  }

  if (Array.isArray(body.preferredAggregators)) {
    for (const a of body.preferredAggregators) {
      if (!isAggregatorSource(a)) {
        return apiError(`preferredAggregators contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    data.preferredAggregators = body.preferredAggregators;
  }

  // Cascade group-safe fields to every sibling when this query is part of a
  // group, mirroring the user PATCH route's behavior. Owner reassignment is
  // single-row only.
  const updatedKeys = Object.keys(data);
  const cascade = existing.groupId && updatedKeys.every((k) => GROUP_CASCADING_FIELDS.has(k));

  if (cascade && existing.groupId) {
    const result = await prisma.query.updateMany({
      where: { groupId: existing.groupId },
      data,
    });
    return apiSuccess({ ...data, updated: result.count });
  }

  const updated = await prisma.query.update({ where: { id }, data });
  return apiSuccess(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { id } = await params;

  const body = await request.json().catch(() => null);
  const groupDelete = body?.groupDelete === true;

  const existing = await prisma.query.findUnique({ where: { id }, select: { groupId: true } });
  if (!existing) return apiError('Query not found', 404);

  if (groupDelete && existing.groupId) {
    const result = await prisma.query.deleteMany({ where: { groupId: existing.groupId } });
    return apiSuccess({ deleted: true, groupDeleted: true, count: result.count });
  }

  await prisma.query.delete({ where: { id } });
  return apiSuccess({ deleted: true, groupDeleted: false });
}
