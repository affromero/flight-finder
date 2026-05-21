import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { authorizeMutation } from '@/lib/query-auth';

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

  const updateData: { scrapeInterval?: number | null; active?: boolean } = {};

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
    updateData.scrapeInterval = interval;
  }

  if (body && Object.prototype.hasOwnProperty.call(body, 'active')) {
    if (typeof body.active !== 'boolean') {
      return apiError('active must be a boolean', 400);
    }
    updateData.active = body.active;
  }

  if (Object.keys(updateData).length === 0) {
    return apiError('No updatable fields supplied', 400);
  }

  // Update this query and all siblings in the group
  const idsToUpdate = [id];
  if (query.groupId) {
    const siblings = await prisma.query.findMany({
      where: { groupId: query.groupId, id: { not: id } },
      select: { id: true },
    });
    idsToUpdate.push(...siblings.map((s) => s.id));
  }

  await prisma.query.updateMany({
    where: { id: { in: idsToUpdate } },
    data: updateData,
  });

  return apiSuccess({ ...updateData, updated: idsToUpdate.length });
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
