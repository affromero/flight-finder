import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { hotelEndpoint, wakeHotelWorker } from '@/lib/hotels/http';
import { createHotelTracker, trackerDto } from '@/lib/hotels/store';
import { HotelError } from '@/lib/hotels/domain';

export async function GET(request: Request) {
  return hotelEndpoint(async actor => {
    const admin = new URL(request.url).searchParams.get('admin') === 'true';
    if (admin && !actor.isAdmin) throw new HotelError('Administrator access required', 403);
    const rows = await prisma.hotelTracker.findMany({ where: admin || actor.userId === null ? {} : { userId: actor.userId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return apiSuccess({ trackers: rows.map(trackerDto) });
  });
}
export async function POST(request: Request) {
  return hotelEndpoint(async actor => {
    const row = await createHotelTracker(await request.json(), actor);
    wakeHotelWorker();
    return apiSuccess({ tracker: trackerDto(row) }, 201);
  });
}
