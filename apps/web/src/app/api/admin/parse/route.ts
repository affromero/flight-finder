import { requireAdminApi, verifyAdminSessionRevocable } from '@/lib/admin-guard';
import { apiSuccess, apiError } from '@/lib/api-response';
import { getCurrentUser } from '@/lib/user-auth';
import { privateParseEndpoint } from '@/lib/parsing/http';
import { parseRecoveryStatus, recoverParseReservation } from '@/lib/parsing/jobs';
import { ParseJobError } from '@/lib/parsing/types';

async function endpoint(action: (actorScope: string) => Promise<Response>): Promise<Response> {
  return privateParseEndpoint(async () => {
    if (process.env.SELF_HOSTED !== 'true') return await verifyAdminSessionRevocable() ? action('instance') : apiError('Unauthorized', 401);
    const denied = await requireAdminApi();
    if (denied) return denied;
    const user = await getCurrentUser();
    if (!user?.isAdmin) return apiError('Administrator access required', 403);
    return action(`user:${user.id}`);
  });
}

export async function GET(): Promise<Response> {
  return endpoint(async actorScope => apiSuccess({ reservations: await parseRecoveryStatus(), actorScope }));
}

export async function POST(request: Request): Promise<Response> {
  return endpoint(async actorScope => {
    const input: unknown = await request.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ParseJobError('Invalid recovery request', 400);
    const fields = input as Record<string, unknown>;
    if (fields.actorScope !== actorScope) throw new ParseJobError('Administrator account changed; reload recovery status', 412);
    if (typeof fields.id !== 'string' || !Number.isSafeInteger(fields.generation) || fields.localWorkersStopped !== true
      || Object.keys(fields).some(key => !['id', 'generation', 'actorScope', 'localWorkersStopped'].includes(key)))
      throw new ParseJobError('Confirm the previous local worker and CLI stopped before recovery', 400);
    await recoverParseReservation(fields.id, fields.generation as number, actorScope);
    return apiSuccess({ reservations: await parseRecoveryStatus(), actorScope });
  });
}
