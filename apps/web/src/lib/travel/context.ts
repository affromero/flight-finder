import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExtractionConfig, Prisma, TravelJob } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { guardTravelJob } from './jobs';
import { ADMISSION_TX_OPTIONS, type TravelLeaseToken } from './admission';
import { currentTravelExecution } from './execution';
import type { TravelVpnSession } from './vpn';

export interface TravelContext {
  job: TravelJob;
  lease: TravelLeaseToken;
  config: ExtractionConfig | null;
  vpn: TravelVpnSession;
}
const contexts = new AsyncLocalStorage<TravelContext>();
export function currentTravelContext(): TravelContext | undefined { return contexts.getStore(); }
export function withTravelContext<T>(context: TravelContext, work: () => Promise<T>): Promise<T> {
  return contexts.run(context, work);
}
export async function travelTransaction<T>(work: (tx: Prisma.TransactionClient, job: TravelJob) => Promise<T>): Promise<T> {
  currentTravelExecution()?.check();
  const context = contexts.getStore();
  if (!context) throw new Error('Travel operation requires admitted execution');
  return prisma.$transaction(async tx => {
    const job = await guardTravelJob(tx, context.job.id, context.lease);
    const result = await work(tx, job);
    await guardTravelJob(tx, context.job.id, context.lease);
    currentTravelExecution()?.check();
    return result;
  }, ADMISSION_TX_OPTIONS);
}
export async function checkTravelAuthority(): Promise<void> {
  await travelTransaction(async () => undefined);
}
