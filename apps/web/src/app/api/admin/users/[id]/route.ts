import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { accountMutationContext, accountMutationBody, manageAccount, accountMutationError } from '@/lib/sidedoor/account-management';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await accountMutationContext(request);
    if (context.response) return context.response;
    const body = await accountMutationBody(request);
    if (!body) return apiError('Invalid JSON body', 400);
    if (Object.keys(body).some(key => !['displayName', 'isAdmin', 'password'].includes(key))) return apiError('Unsupported account field', 400);
    if (body.password !== undefined && typeof body.password !== 'string') return apiError('Invalid password', 400);
    if (body.isAdmin !== undefined && typeof body.isAdmin !== 'boolean') return apiError('Invalid role', 400);
    if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') return apiError('Invalid display name', 400);
    const profile = body.displayName === undefined ? {} : { displayName: typeof body.displayName === 'string' ? body.displayName.trim() || null : null };
    if (!Object.keys(body).length) return apiError('No supported fields to update', 400);
    const { id } = await params;
    const user = await manageAccount(context.token!, {
      kind: 'update', id,
      password: typeof body.password === 'string' ? body.password : undefined,
      role: typeof body.isAdmin === 'boolean' ? body.isAdmin ? 'owner' : 'member' : undefined,
    }, profile);
    return apiSuccess({ user });
  } catch (error) { return accountMutationError(error); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await accountMutationContext(request);
    if (context.response) return context.response;
    const { id } = await params;
    await manageAccount(context.token!, { kind: 'delete', id });
    return apiSuccess({ deleted: true });
  } catch (error) { return accountMutationError(error); }
}
