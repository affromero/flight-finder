import { apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { accessRouteResponse } from '@/lib/sidedoor/access/access-http';
import { currentAccessSession } from '@/lib/sidedoor/access/session';
import { sharedAccess } from '@/lib/sidedoor/access/service';
import { readAccessJson } from 'thesidedoor-core/access/http';

export async function POST(request: Request) {
  const origin = await accessRouteResponse(request, 'check-origin', {});
  if (!origin.ok) return origin;
  if (!(await isMultiUserEnabled())) return apiError('Not found', 404);
  const body = await readAccessJson(request).catch(() => null);
  if (!body || typeof body !== 'object' || !('username' in body) || typeof body.username !== 'string')
    return apiError('Missing username', 400);
  const username = body.username.trim();
  if (!username) return apiError('Missing username', 400);
  const password = 'password' in body && typeof body.password === 'string' ? body.password : '';
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return accessRouteResponse(request, 'login', { name: username, password });
  const state = await sharedAccess.store.read();
  const principal = state.principals.find(candidate => candidate.id === user.id);
  if (!principal) return apiError('Unauthorized', 401);
  const profile = { id: user.id, username: user.username, displayName: user.displayName, isAdmin: false };
  if (principal.passwordHash !== null || state.passkeys.some(passkey => passkey.principalId === principal.id) || password) {
    return accessRouteResponse(request, 'login', { name: username, password }, payload => {
      const principal = payload && typeof payload === 'object' && 'principal' in payload ? payload.principal : null;
      const owner = principal && typeof principal === 'object' && 'role' in principal && principal.role === 'owner';
      return { user: { ...profile, isAdmin: Boolean(owner) } };
    });
  }
  if (await currentAccessSession()) {
    return accessRouteResponse(request, 'select-profile', { id: user.id }, () => ({ user: profile }));
  }
  return accessRouteResponse(request, 'open-profile', { id: user.id }, () => ({ user: profile }));
}
