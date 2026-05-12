import type { PriceData } from '@/lib/scraper/extract-prices';

export interface PreviewRequestPayload {
  dateFrom: string;
  dateTo: string;
  maxPrice: number | null;
  maxStops: number | null;
  maxDurationHours: number | null;
  preferredAirlines: string[];
  timePreference: string;
  cabinClass: string;
  tripType: string;
  currency: string | null;
  outboundDates?: string[];
  returnDates?: string[];
  origins: Array<{ code: string; name: string }>;
  destinations: Array<{ code: string; name: string }>;
  origin?: string;
  originName?: string;
  destination?: string;
  destinationName?: string;
}

export interface RouteResultPayload {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  flights: PriceData[];
  date?: string;
  returnDate?: string;
  error?: string;
}

export interface PreviewResultPayload {
  routes: RouteResultPayload[];
  flights?: PriceData[];
}

export interface PreviewRunStatusPayload {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: PreviewResultPayload | null;
  error: string | null;
  expiresAt: string;
}

/**
 * Single source of truth for preview run timeouts and status sets. Both the
 * POST handler (kicks off background scrape, sweeps stale rows) and the GET
 * handler (returns status, marks stale rows failed on read) import these so
 * the windows cannot drift. The 30 minute window is paired with a per task
 * heartbeat in runPreviewInBackground; without the heartbeat, long but
 * healthy scrapes get falsely failed.
 */
export const PREVIEW_ACTIVE_TIMEOUT_MS = 30 * 60 * 1000;
export const PREVIEW_TIMEOUT_ERROR = 'Preview run timed out before completing';
export const ACTIVE_PREVIEW_STATUSES = ['pending', 'running'] as const;
export const TERMINAL_PREVIEW_STATUSES = ['completed', 'failed'] as const;
export type ActivePreviewStatus = typeof ACTIVE_PREVIEW_STATUSES[number];
export type TerminalPreviewStatus = typeof TERMINAL_PREVIEW_STATUSES[number];
