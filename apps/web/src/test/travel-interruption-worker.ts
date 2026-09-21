import { prisma } from '../lib/prisma';
import { executeTravelJob } from '../lib/travel/executor';
import { travelDelay } from '../lib/travel/execution';
import { launchBrowser } from '../lib/scraper/browser';

async function run(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
  if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Worker requires disposable localhost:55440/car_test');
  const id = process.argv[2];
  if (!id || !process.send) throw new Error('Worker requires a job and an IPC parent');
  try {
    await executeTravelJob(id, async () => {
      await launchBrowser();
      process.send?.({ ready: true });
      await travelDelay(30_000);
      return { stale: true };
    });
    throw new Error('Interrupted worker unexpectedly succeeded');
  } catch (error) {
    const job = await prisma.travelJob.findUniqueOrThrow({ where: { id } });
    if (job.status !== 'failed' || job.result !== null) throw error;
  }
}

void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.$disconnect();
  process.disconnect?.();
});
