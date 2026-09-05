import { apiSuccess } from '@/lib/api-response';
import { createHotelSearch } from '@/lib/hotels/store';
import { hotelEndpoint, wakeHotelWorker } from '@/lib/hotels/http';

export async function POST(request: Request) {
  return hotelEndpoint(async actor => {
    const run = await createHotelSearch(await request.json(), actor);
    wakeHotelWorker();
    return apiSuccess({ id: run.id, status: run.status }, 202);
  });
}
