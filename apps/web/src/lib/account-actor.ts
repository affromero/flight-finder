import type { Prisma } from '@/generated/prisma/client';
import { TravelJobError } from './travel/errors';

/** Recheck a solo actor after acquiring admission, which serializes account enablement. */
export async function assertAccountActor(tx: Prisma.TransactionClient, actor: { userId: string | null }): Promise<void> {
  if (actor.userId !== null || process.env.SELF_HOSTED !== 'true') return;
  const config = await tx.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { multiUserMode: true } });
  if (config?.multiUserMode) throw new TravelJobError('Accounts were enabled. Sign in and retry.', 401);
}
