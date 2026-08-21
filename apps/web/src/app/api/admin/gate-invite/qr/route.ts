import { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { apiError } from '@/lib/api-response';
import { gateEnabled } from '@/lib/access/gate';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';

/**
 * Render an invite URL as an SVG QR code. Same admin requirement as minting the
 * invite: this renders whatever it is handed, so leaving it open would turn the
 * admin surface into an arbitrary-QR generator.
 */
export async function GET(request: NextRequest) {
  if (!gateEnabled()) return apiError('This instance is not gated', 404);
  if (!(await isMultiUserEnabled())) return apiError('Multi-user mode is off', 409);

  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);
  if (!user.isAdmin) return apiError('Forbidden', 403);

  const raw = request.nextUrl.searchParams.get('url');
  if (!raw) return apiError('Missing url', 400);

  // Only ever encode a link back into this instance's own gate.
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return apiError('Invalid url', 400);
  }
  if (target.origin !== new URL(request.url).origin || target.pathname !== '/gate') {
    return apiError('Invalid url', 400);
  }

  const svg = await QRCode.toString(target.toString(), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      // A working credential — never store it anywhere.
      'Cache-Control': 'no-store',
    },
  });
}
