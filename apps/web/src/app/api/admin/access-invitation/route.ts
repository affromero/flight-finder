import { accessRouteResponse, withAccessBody } from '@/lib/sidedoor/access-http';
import { accessHandler } from '@/lib/sidedoor/access';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const authorized = await (await accessHandler())(withAccessBody(request, {}), 'authorize-owner');
  if (!authorized.ok) return authorized;
  return accessRouteResponse(request, 'issue-invitation', { ttlMs: 24 * 60 * 60 * 1000, uses: 1 }, payload => {
    if (!payload || typeof payload !== 'object' || !('code' in payload) || typeof payload.code !== 'string' || !('mode' in payload) || !['household', 'individual'].includes(String(payload.mode)) || !('origin' in payload) || typeof payload.origin !== 'string')
      throw new Error('Invitation issuance could not be confirmed');
    return { url: `${payload.origin}/access?mode=invite#invite=${encodeURIComponent(payload.code)}&mode=${payload.mode}` };
  });
}
