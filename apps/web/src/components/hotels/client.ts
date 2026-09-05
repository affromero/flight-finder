import type { ApiResponse } from '@/lib/api-response';
import type { HotelOffer, HotelSearch, HotelSelection, HotelTrackingOptions } from '@/lib/hotels/types';

export interface HotelTrackerView {
  id: string; userId?: string | null; hotelName: string; search: HotelSearch; selection: HotelSelection;
  options: HotelTrackingOptions; active: boolean; createdAt: string; updatedAt: string;
  lastCheckedAt: string | null; lastError: string | null; latestPrice: number | null; currency: string;
}
export interface HotelDetailView {
  tracker: HotelTrackerView;
  snapshots: { id: string; runId: string; scrapedAt: string; offer: HotelOffer; eligible: boolean }[];
  runs: { id: string; status: string; error: string | null; createdAt: string }[];
  notificationsConfigured: boolean;
}
export async function hotelRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body: ApiResponse<T> = await response.json();
  if (!body.ok) throw new Error(body.error);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return body.data;
}
export function hotelMoney(value: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}
export function safeHotelUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}
export function hotelHistoryObservations(snapshots: HotelDetailView['snapshots']): HotelDetailView['snapshots'] {
  const checks = new Map<string, HotelDetailView['snapshots'][number]>();
  for (const snapshot of snapshots) {
    if (!snapshot.eligible) continue;
    const previous = checks.get(snapshot.runId);
    if (!previous || snapshot.offer.totalPrice < previous.offer.totalPrice) checks.set(snapshot.runId, snapshot);
  }
  return [...checks.values()].sort((a, b) => Date.parse(a.scrapedAt) - Date.parse(b.scrapedAt));
}
