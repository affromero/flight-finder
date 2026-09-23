import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { accountMutationContext, accountMutationBody, manageAccount, accountMutationError } from '@/lib/sidedoor/access/account-management';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { isPresetSlug } from '@/lib/avatars';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;

async function requireAdmin() {
  if (!(await isMultiUserEnabled())) return { ok: false as const, status: 404 };
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, status: 401 };
  if (!user.isAdmin) return { ok: false as const, status: 403 };
  return { ok: true as const, user };
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return apiError('Unauthorized', auth.status);

  const users = await prisma.user.findMany({
    orderBy: [{ isAdmin: 'desc' }, { username: 'asc' }],
    select: {
      id: true,
      username: true,
      displayName: true,
      avatar: true,
      isAdmin: true,
      createdAt: true,
      _count: { select: { queries: true } },
    },
  });

  return apiSuccess({ users });
}

export async function POST(request: NextRequest) {
  try {
    const context = await accountMutationContext(request);
    if (context.response) return context.response;
    const body = await accountMutationBody(request);
    if (!body) return apiError('Invalid JSON body', 400);
    if (Object.keys(body).some(key => !['username', 'displayName', 'avatar'].includes(key))) return apiError('Unsupported account field', 400);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!USERNAME_PATTERN.test(username)) return apiError('Username must be 2 to 32 characters of letters, numbers, underscores, dots, or dashes', 400);
    const user = await manageAccount(context.token!, {
      kind: 'create', name: username,
      role: 'member',
    }, {
      displayName: typeof body.displayName === 'string' ? body.displayName.trim() || null : null,
      avatar: isPresetSlug(body.avatar) ? body.avatar : null,
    });
    return apiSuccess({ user }, 201);
  } catch (error) { return accountMutationError(error); }
}
