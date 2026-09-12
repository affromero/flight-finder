import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { hotelEndpoint, wakeHotelWorker } from '@/lib/hotels/http';
import { assertHotelOwner } from '@/lib/hotels/access';
import { cancelTravelJob, lockTravelAdmission } from '@/lib/travel/jobs';
import { assertTravelAvailable } from '@/lib/travel/admission';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const { id } = await context.params;
    const run = await prisma.hotelSearchRun.findUnique({ where: { id } });
    assertHotelOwner(actor, run);
    if (run && ['queued', 'running'].includes(run.status)) {
      await assertTravelAvailable(actor.isAdmin);
      wakeHotelWorker();
    }
    return apiSuccess({ id, status: run?.status, result: run?.result, error: run?.error });
  });
}
export async function DELETE(request: Request, context: Context) {
  return hotelEndpoint(async actor => {
    const { id } = await context.params;
    const status = await prisma.$transaction(async tx => {
      await lockTravelAdmission(tx);
      const run = await tx.hotelSearchRun.findUnique({ where: { id }, include: { travelJob: true } });
      assertHotelOwner(actor, run);
      if (!run || !['queued', 'running'].includes(run.status)) return run?.status;
      if (run.travelJob) await cancelTravelJob(run.travelJob.id, actor.userId, actor.isAdmin, tx);
      await tx.hotelSearchRun.update({ where: { id }, data: { status: 'cancelled', completedAt: new Date() } });
      return 'cancelled';
    });
    return apiSuccess({ id, status });
  });
}
