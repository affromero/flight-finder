import { apiSuccess, apiError } from '@/lib/api-response';
import { getCurrentUser } from '@/lib/user-auth';
import { isMultiUserEnabled } from '@/lib/multi-user';

export async function GET() {
  if (!(await isMultiUserEnabled())) {
    return apiError('Not found', 404);
  }

  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);

  return apiSuccess({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      defaultCurrency: user.defaultCurrency,
      defaultCountry: user.defaultCountry,
      preferredAirlines: user.preferredAirlines,
      cabinClass: user.cabinClass,
    },
  });
}
