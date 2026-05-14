import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const existing = await prisma.query.findUnique({ where: { id } });
  if (!existing || !existing.isSeed) return apiError('Seed route not found', 404);

  const data: Record<string, unknown> = {};

  if (typeof body.active === 'boolean') data.active = body.active;
  if (body.scrapeInterval === null) {
    data.scrapeInterval = null;
  } else if (typeof body.scrapeInterval === 'number' && [1, 3, 6, 12, 24].includes(body.scrapeInterval)) {
    data.scrapeInterval = body.scrapeInterval;
  }
  if (typeof body.lookAheadDays === 'number' && [7, 14, 21, 30].includes(body.lookAheadDays)) {
    data.lookAheadDays = body.lookAheadDays;
  }

  const updated = await prisma.query.update({ where: { id }, data });
  return apiSuccess(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const { id } = await params;

  const existing = await prisma.query.findUnique({ where: { id } });
  if (!existing || !existing.isSeed) return apiError('Seed route not found', 404);

  await prisma.query.delete({ where: { id } });
  return apiSuccess({ deleted: true });
}
