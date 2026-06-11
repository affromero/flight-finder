import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { isPresetSlug } from '@/lib/avatars';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;
const MIN_PASSWORD_LENGTH = 8;

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
  const auth = await requireAdmin();
  if (!auth.ok) return apiError('Unauthorized', auth.status);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName =
    typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim()
      : null;
  const isAdmin = typeof body.isAdmin === 'boolean' ? body.isAdmin : false;
  const avatar = isPresetSlug(body.avatar) ? body.avatar : null;

  if (!USERNAME_PATTERN.test(username)) {
    return apiError('Username must be 2 to 32 characters of letters, numbers, underscores, dots, or dashes', 400);
  }
  // Anyone can be passwordless (tap-to-sign-in); a given password must be strong.
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return apiError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  const existing = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (existing) return apiError('Username already taken', 409);

  const passwordHash = password ? await hashPassword(password) : null;
  const user = await prisma.user.create({
    data: { username, displayName, passwordHash, isAdmin, avatar },
    select: { id: true, username: true, displayName: true, avatar: true, isAdmin: true, createdAt: true },
  });

  return apiSuccess({ user }, 201);
}
