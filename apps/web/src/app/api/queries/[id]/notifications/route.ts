import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { NotificationPolicyError, readNotificationSettings, updateNotificationSettings } from '@/lib/notifications/subscriptions/policy';

export const dynamic = 'force-dynamic';

async function respond(work: () => Promise<unknown>) {
  try {
    const response = apiSuccess({ settings: await work() });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (!(error instanceof NotificationPolicyError)) throw error;
    const response = apiError(error.message, error.status);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(() => readNotificationSettings(id, request.headers.get('x-delete-token')));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);
  const token = body && typeof body === 'object' && 'deleteToken' in body && typeof body.deleteToken === 'string' ? body.deleteToken : null;
  return respond(() => updateNotificationSettings(id, token, body));
}
