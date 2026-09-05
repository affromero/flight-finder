import { after } from 'next/server';
import { apiError } from '@/lib/api-response';
import { HotelError } from './domain';
import { hotelActor, type HotelActor } from './access';
import { runHotelJobsSafely } from './runner';

export function wakeHotelWorker() { after(runHotelJobsSafely); }
export async function hotelEndpoint(action: (actor: HotelActor) => Promise<Response>): Promise<Response> {
  try { return await action(await hotelActor()); }
  catch (error) {
    if (error instanceof HotelError) return apiError(error.message, error.status);
    if (error instanceof SyntaxError) return apiError('Invalid JSON request', 400);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') return apiError('Another hotel operation is in progress; retry', 409);
    console.error('[hotels] Request failed:', error instanceof Error ? error.message : error);
    return apiError('Hotel operation failed; check the server logs and retry', 500);
  }
}
