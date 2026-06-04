import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';

const MIN_PASSWORD_LENGTH = 8;

async function requireAdmin() {
  if (!(await isMultiUserEnabled())) return { ok: false as const, status: 404 };
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, status: 401 };
  if (!user.isAdmin) return { ok: false as const, status: 403 };
  return { ok: true as const, user };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return apiError('Unauthorized', auth.status);

  const { id } = await params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return apiError('User not found', 404);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const data: Record<string, unknown> = {};

  if (typeof body.displayName === 'string') {
    data.displayName = body.displayName.trim() || null;
  } else if (body.displayName === null) {
    data.displayName = null;
  }

  if (typeof body.isAdmin === 'boolean') {
    // Block self demotion to avoid locking the household out of admin access
    if (target.id === auth.user.id && target.isAdmin && body.isAdmin === false) {
      return apiError('Cannot remove your own admin role', 400);
    }
    data.isAdmin = body.isAdmin;
  }

  if (typeof body.password === 'string' && body.password.length > 0) {
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return apiError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
    }
    data.passwordHash = await hashPassword(body.password);
    data.sessionsValidFrom = new Date(); // a reset revokes the target user's existing sessions
  }

  if (Object.keys(data).length === 0) {
    return apiError('No supported fields to update', 400);
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, username: true, displayName: true, isAdmin: true, createdAt: true },
  });

  return apiSuccess({ user: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return apiError('Unauthorized', auth.status);

  const { id } = await params;
  if (id === auth.user.id) {
    return apiError('Cannot delete your own account', 400);
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return apiError('User not found', 404);

  await prisma.user.delete({ where: { id } });
  return apiSuccess({ deleted: true });
}
