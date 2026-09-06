import { runHotelJobsSafely } from './runner';

const runtime = globalThis as typeof globalThis & { hotelTimer?: ReturnType<typeof setInterval> };
export function startHotelScheduler() {
  if (process.env.SELF_HOSTED !== 'true' || process.env.CRON_ENABLED === 'false' || runtime.hotelTimer) return;
  runtime.hotelTimer = setInterval(() => { void runHotelJobsSafely(); }, 60_000);
  runtime.hotelTimer.unref();
}
