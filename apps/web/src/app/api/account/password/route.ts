import { apiError } from '@/lib/api-response';
import { readAccessJson } from 'thesidedoor-core/access/http';
import { accessRouteResponse } from '@/lib/sidedoor/access/access-http';

/** Keep the existing password-change payload while shared access owns verification and revocation. */
export async function POST(request: Request) {
  const origin = await accessRouteResponse(request, 'check-origin', {});
  if (!origin.ok) return origin;
  const body = await readAccessJson(request).catch(() => null);
  if (!body || typeof body !== 'object' || !('newPassword' in body) || typeof body.newPassword !== 'string' ||
    !('currentPassword' in body) || typeof body.currentPassword !== 'string') return apiError('Invalid password request', 400);
  return accessRouteResponse(request, 'change-password', { password: body.newPassword, currentPassword: body.currentPassword }, () => ({ changed: true }));
}
