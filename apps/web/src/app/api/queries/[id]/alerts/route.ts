import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { readPriceRules, updatePriceRules } from '@/lib/notifications/rules/store';
import { PriceRuleError } from '@/lib/notifications/rules/config';

export const dynamic = 'force-dynamic';

async function respond(work: () => Promise<unknown>) {
  try {
    const response = apiSuccess({ settings: await work() });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (!(error instanceof PriceRuleError)) throw error;
    const response = apiError(error.message, error.status);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(() => readPriceRules(id, request.headers.get('x-delete-token')));
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);
  const token = body && typeof body === 'object' && 'deleteToken' in body && typeof body.deleteToken === 'string' ? body.deleteToken : null;
  return respond(() => updatePriceRules(id, token, body));
}
