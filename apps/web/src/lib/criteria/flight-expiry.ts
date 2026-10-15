/** Track through the outbound calendar day, using UTC throughout the app. */
export function flightDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function flightExpiry(dateFrom: Date): Date {
  return new Date(Date.UTC(dateFrom.getUTCFullYear(), dateFrom.getUTCMonth(), dateFrom.getUTCDate() + 1));
}

/** Seed routes have rolling travel dates and retain their configured expiry. */
export function trackerExpiry(query: { dateFrom: Date; expiresAt: Date; isSeed?: boolean }): Date {
  return query.isSeed ? query.expiresAt : flightExpiry(query.dateFrom);
}

export function hasFlightExpired(query: { dateFrom: Date; isSeed?: boolean }, now = new Date()): boolean {
  return !query.isSeed && flightExpiry(query.dateFrom).getTime() <= now.getTime();
}

export function flightRefreshTarget(
  queries: readonly { id: string; dateFrom: Date | string; active?: boolean; isSeed?: boolean }[],
  now = new Date(),
): string | null {
  for (const query of queries) {
    if (!query.active || query.isSeed) continue;
    const dateFrom = typeof query.dateFrom === 'string' ? new Date(query.dateFrom) : query.dateFrom;
    if (!hasFlightExpired({ dateFrom }, now)) return query.id;
  }
  return null;
}
