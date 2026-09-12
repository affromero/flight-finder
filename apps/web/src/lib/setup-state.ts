import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';

/** Existing accounts close bootstrap even after solo-mode recovery clears the legacy hash. */
export async function setupComplete(db: Pick<Prisma.TransactionClient, 'extractionConfig' | 'user'> = prisma): Promise<boolean> {
  const config = await db.extractionConfig.findFirst({ where: { id: 'singleton' } });
  if (config?.adminPasswordHash || config?.multiUserMode) return true;
  return await db.user.count() > 0;
}
