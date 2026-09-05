import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { hotelEndpoint } from '@/lib/hotels/http';
import { getHotelTracker, editHotelTracker, trackerDto, lockHotelTracker } from '@/lib/hotels/store';
import { assertHotelOwner } from '@/lib/hotels/access';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const { id } = await context.params;
    const row = await getHotelTracker(id, actor);
    const [snapshots, runs, channels] = await Promise.all([
      prisma.hotelSnapshot.findMany({ where: { trackerId: id }, orderBy: { scrapedAt: 'desc' }, take: 1000 }),
      prisma.hotelSearchRun.findMany({ where: { trackerId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, error: true, createdAt: true } }),
      prisma.notificationChannel.count({ where: { enabled: true, OR: [{ userId: row.userId }, { userId: null }] } }),
    ]);
    return apiSuccess({ tracker: trackerDto(row), snapshots, runs, notificationsConfigured: channels > 0, canReassign: actor.isAdmin && actor.userId !== null });
  });
}
export async function PATCH(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const row = await editHotelTracker((await context.params).id, await request.json(), actor);
    return apiSuccess({ tracker: trackerDto(row) });
  });
}
export async function DELETE(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const { id } = await context.params;
    await prisma.$transaction(async tx => {
      const row = await lockHotelTracker(tx, id);
      assertHotelOwner(actor, row);
      await tx.hotelTracker.delete({ where: { id } });
    });
    return apiSuccess({ id, deleted: true });
  });
}
