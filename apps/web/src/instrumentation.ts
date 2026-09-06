export async function register() {
  // Only start cron on the Node.js server, not in Edge runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startCron } = await import('./lib/cron');
    await startCron();
    const { startHotelScheduler } = await import('./lib/hotels/schedule');
    startHotelScheduler();
  }
}
