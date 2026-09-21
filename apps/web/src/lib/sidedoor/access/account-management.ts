import { cookies } from 'next/headers';
import { PrincipalManagement, isAccessError, type PrincipalMutation } from 'thesidedoor-core/access';
import { readAccessJson } from 'thesidedoor-core/access/http';
import { apiError } from '@/lib/api-response';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { accessHandler } from './access';
import { withAccessBody } from './access-http';
import { sharedAccess, sharedAccessStore, SHARED_SESSION_COOKIE } from './service';
import { AccountNotFoundError } from './access-store';

export async function accountMutationContext(request: Request) {
  const preflight = await (await accessHandler())(withAccessBody(request, {}), 'authorize-owner');
  if (!preflight.ok) return { response: preflight };
  if (!(await isMultiUserEnabled())) return { response: apiError('Multi user mode is not enabled', 404) };
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return { response: apiError('Unauthorized', 401) };
  await sharedAccess.authenticate(token, true, true);
  return { token };
}

export async function accountMutationBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readAccessJson(request).catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

export async function manageAccount(token: string, mutation: PrincipalMutation, profile: { displayName?: string | null; avatar?: string | null } = {}) {
  const prepared = await new PrincipalManagement(sharedAccess).prepare(mutation);
  return sharedAccessStore.managePrincipal(token, prepared, profile);
}

export function accountMutationError(error: unknown) {
  if (error instanceof AccountNotFoundError) return apiError('User not found', 404);
  if (isAccessError(error)) return apiError(error.message, { unauthorized: 401, forbidden: 403, invalid: 400, conflict: 409, rate_limited: 429 }[error.code]);
  if (error instanceof Error && 'code' in error && error.code === 'P2002') return apiError('Username already taken', 409);
  throw error;
}
