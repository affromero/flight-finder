import { prisma } from '@/lib/prisma';
import type { TravelJob } from '@/generated/prisma/client';
import { getTravelAdmission, type TravelLeaseToken } from './admission';
import { TravelJobError } from './errors';
import { currentTravelContext } from './context';
import { executeCarJob } from '../cars/run';
import { executeTravelJob as execute } from './executor';

async function dispatch(job: TravelJob, lease: TravelLeaseToken): Promise<unknown> {
  if (job.kind === 'flight_preview') throw new TravelJobError('Preview work belongs to its originating process');
  if (job.kind === 'car_search') return executeCarJob(job.id, lease);
  if (job.kind === 'hotel_search') {
    const { executeHotelJob } = await import('../hotels/runner');
    return executeHotelJob(job.id, lease);
  }
  const { runScrapeAll, runFullScrapeForQuery, runScrapeForQuery } = await import('../scraper/run-scrape');
  if (job.kind === 'flight_batch') return runScrapeAll();
  const first = await prisma.fetchRun.findFirst({ where: { travelJobId: job.id, status: 'in_progress' }, orderBy: { startedAt: 'asc' }, select: { id: true } });
  if (!job.queryId) throw new TravelJobError('Flight job has no query');
  const request = job.request;
  if (request && typeof request === 'object' && !Array.isArray(request) && request.mode === 'single') {
    if (request.country !== null && typeof request.country !== 'string') throw new TravelJobError('Invalid queued flight country');
    const vpn = currentTravelContext()!.vpn;
    if (request.country) await vpn.connect(request.country);
    return runScrapeForQuery(job.queryId, request.country, request.country ? vpn.getProxyUrl() : undefined, first ? { fetchRunId: first.id } : undefined);
  }
  return runFullScrapeForQuery(job.queryId, first ? { fetchRunId: first.id } : undefined);
}

export async function executeTravelJob(id: string, work = dispatch): Promise<boolean> {
  return execute(id, work);
}

export async function pumpTravelJobs(): Promise<void> {
  const config = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { enabled: true } });
  if (config?.enabled === false) return;
  if ((await getTravelAdmission()).quarantinedAt) return;
  const jobs = await prisma.travelJob.findMany({ where: { status: 'queued', kind: { in: process.env.SELF_HOSTED === 'true' ? ['flight_batch', 'flight_query', 'hotel_search', 'car_search'] : ['flight_batch', 'flight_query'] } }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 20 });
  for (const job of jobs) {
    try { await executeTravelJob(job.id); }
    catch (error) {
      console.error('[travel] Worker failed:', error);
      if ((await getTravelAdmission()).quarantinedAt) return;
    }
  }
}

export async function awaitTravelJob(id: string): Promise<unknown> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    await executeTravelJob(id);
    const job = await prisma.travelJob.findUnique({ where: { id } });
    if (!job) throw new TravelJobError('Travel job no longer exists', 404);
    if (job.status === 'succeeded') return job.result;
    if (job.status === 'failed' || job.status === 'cancelled') throw new TravelJobError(job.error ?? 'Travel job was cancelled');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new TravelJobError('Travel work remains queued or running; check its status before retrying', 503);
}
