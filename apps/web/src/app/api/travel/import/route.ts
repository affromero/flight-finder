import { apiError, apiSuccess } from '@/lib/api-response';
import { importTravelDraft } from '@/lib/travel/import-draft';
import { readCarJson } from '@/lib/cars/http';
import { CarError } from '@/lib/cars/types';
import { carActor } from '@/lib/cars/access';
import { hotelActor } from '@/lib/hotels/access';
import { HotelError } from '@/lib/hotels/domain';

export async function POST(request: Request) {
  try {
    const body = await readCarJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Expected an import request', 400);
    const { kind, url } = body as Record<string, unknown>;
    if (kind !== 'flights' && kind !== 'hotels' && kind !== 'cars') return apiError('Choose flights, hotels or cars', 400);
    if (kind === 'cars') await carActor();
    if (kind === 'hotels') await hotelActor();
    // Decoding is local and bounded. No provider request, AI call or job starts here.
    return apiSuccess(importTravelDraft(url, kind));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Could not import this link', error instanceof CarError || error instanceof HotelError ? error.status : 400);
  }
}
