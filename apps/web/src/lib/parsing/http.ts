import { apiError } from '@/lib/api-response';
import { getCurrentUser } from '@/lib/user-auth';
import { parseCapability, type ParseActor } from './jobs';
import { ParseJobError } from './types';

export async function requestParseActor(request: Request): Promise<ParseActor> {
  const user = await getCurrentUser();
  return { ownerId: user?.id ?? null, capability: parseCapability(request.headers.get('x-parse-capability')) };
}

export async function privateParseEndpoint(action: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try { response = await action(); }
  catch (error) {
    response = error instanceof ParseJobError ? apiError(error.message, error.status) : apiError('Async parsing is unavailable', 503);
    if (response.status === 429) response.headers.set('Retry-After', '15');
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}
