import { apiSuccess } from '@/lib/api-response';
import { hotelEndpoint } from '@/lib/hotels/http';
import { HotelError, validateHotelSearch } from '@/lib/hotels/domain';
import { parseHotelQuery } from '@/lib/hotels/parse';

export async function POST(request: Request) {
  return hotelEndpoint(async () => {
    const body = await request.json() as { text?: unknown };
    if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 2000) throw new HotelError('Describe your stay in 1–2000 characters');
    return apiSuccess({ search: validateHotelSearch(await parseHotelQuery(body.text)) });
  });
}
