import { accessHandler } from '@/lib/sidedoor/access/access';
import { apiError } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await context.params;
    return await (await accessHandler())(request, action);
  } catch {
    const response = apiError('Access configuration is unavailable. Check the instance configuration.', 503);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}

export { handle as GET, handle as POST };
