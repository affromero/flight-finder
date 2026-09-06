import { apiSuccess } from '@/lib/api-response';
import { hotelEndpoint, wakeHotelWorker } from '@/lib/hotels/http';
import { refreshHotelTracker } from '@/lib/hotels/store';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return hotelEndpoint(async actor => {
    const run = await refreshHotelTracker((await context.params).id, actor);
    wakeHotelWorker();
    return apiSuccess({ id: run.id, status: run.status }, 202);
  });
}
