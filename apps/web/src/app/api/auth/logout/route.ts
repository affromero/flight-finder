import { apiSuccess, apiError } from '@/lib/api-response';
import { clearSessionCookie } from '@/lib/admin-auth';
import { isMultiUserEnabled } from '@/lib/multi-user';

export async function POST() {
  if (!(await isMultiUserEnabled())) {
    return apiError('Not found', 404);
  }
  await clearSessionCookie();
  return apiSuccess({ ok: true });
}
