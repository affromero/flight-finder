import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { hotelEndpoint, wakeHotelWorker } from '@/lib/hotels/http';
import { assertHotelOwner } from '@/lib/hotels/access';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const { id } = await context.params;
    const run = await prisma.hotelSearchRun.findUnique({ where: { id } });
    assertHotelOwner(actor, run);
    if (run && ['queued', 'running'].includes(run.status)) wakeHotelWorker();
    return apiSuccess({ id, status: run?.status, result: run?.result, error: run?.error });
  });
}
export async function DELETE(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const { id } = await context.params;
    const run = await prisma.hotelSearchRun.findUnique({ where: { id } });
    assertHotelOwner(actor, run);
    await prisma.hotelSearchRun.updateMany({ where: { id, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled', completedAt: new Date() } });
    return apiSuccess({ id, status: 'cancelled' });
  });
}
