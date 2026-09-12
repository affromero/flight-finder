import { deliverFlightAlerts, recordFlightAlert } from './flights';
export { resolveBaseUrl } from './base-url';

/** Existing callers can detect idempotently; delivery also runs independently. */
export async function notifyNewLows(queryIds: string[], cycleStartedAt: Date): Promise<void> {
  const ids = [...new Set(queryIds)];
  if (ids.length === 0) return;
  for (const queryId of ids) {
    try { await recordFlightAlert(queryId, cycleStartedAt); }
    catch (error) { console.error(`[notify] query=${queryId} notification failed:`, error instanceof Error ? error.message : 'Unknown error'); }
  }
  await deliverFlightAlerts();
}
