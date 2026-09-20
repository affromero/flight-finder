export async function register() {
  // Only start cron on the Node.js server, not in Edge runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertAccessInitialized } = await import('./lib/sidedoor/access/access-store');
    const { providerVault } = await import('./lib/sidedoor/providers/provider-credentials');
    const { prisma } = await import('./lib/prisma');
    await assertAccessInitialized();
    await providerVault(prisma).store.read();
    const { startCron } = await import('./lib/cron');
    await startCron();
    const { startTravelScheduler } = await import('./lib/travel/schedule');
    startTravelScheduler();
  }
}
