import type { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { getCurrentUser } from '@/lib/user-auth';

/** Retained application API. Authority comes from the live shared principal. */
export async function verifyAdminSessionRevocable(): Promise<boolean> {
  return (await getCurrentUser())?.isAdmin === true;
}

export async function requireAdminApi(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);
  if (!user.isAdmin) return apiError('Forbidden', 403);
  return null;
}
