import { apiSuccess } from '@/lib/api-response';
import { clearSessionCookie } from '@/lib/admin-auth';

export async function POST() {
  await clearSessionCookie();
  return apiSuccess({ ok: true });
}
