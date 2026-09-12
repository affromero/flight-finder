import type { Prisma } from '@/generated/prisma/client';
import { cancelTravelJob, lockTravelAdmission } from './travel/jobs';
import { interruptTravelRun } from './travel/interruption';

/** Admission must remain locked until the account-mode transaction commits. */
export async function migrateSoloOwnership(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  await lockTravelAdmission(tx);
  const running = await tx.travelJob.findMany({ where: { status: 'running', userId: null } });
  for (const job of running) {
    await cancelTravelJob(job.id, null, true, tx);
    await interruptTravelRun(tx, job, 'Accounts were enabled during this check. Refresh to retry.');
  }
  // Cancellation fences result commits. The original process still owns its
  // lease and must finish browser and VPN cleanup before another worker starts.
  await tx.travelAlertDelivery.updateMany({
    where: { pending: true, OR: [{ query: { userId: null, isSeed: false } }, { hotelAlert: { tracker: { userId: null } } }, { carTracker: { userId: null } }] },
    data: { pending: false, claimToken: null, claimExpiresAt: null },
  });
  await tx.hotelAlert.updateMany({ where: { pending: true, tracker: { userId: null } }, data: { pending: false } });
  const queries = await tx.query.updateMany({ where: { userId: null, isSeed: false }, data: { userId } });
  await tx.hotelTracker.updateMany({ where: { userId: null }, data: { userId } });
  await tx.hotelSearchRun.updateMany({ where: { userId: null }, data: { userId } });
  await tx.carTracker.updateMany({ where: { userId: null }, data: { userId } });
  await tx.carSearchRun.updateMany({ where: { userId: null }, data: { userId } });
  await tx.carTrackerCreation.updateMany({ where: { userId: null }, data: { userId } });
  await tx.carSearchCreation.updateMany({ where: { userId: null }, data: { userId } });
  await tx.carRefreshRequest.updateMany({ where: { userId: null }, data: { userId } });
  await tx.travelJob.updateMany({
    where: { userId: null, OR: [{ query: { userId } }, { hotelRun: { userId } }, { carRun: { userId } }] },
    data: { userId },
  });
  return queries.count;
}
