import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import {
  ACTIVE_PREVIEW_STATUSES,
  PREVIEW_ACTIVE_TIMEOUT_MS,
  PREVIEW_TIMEOUT_ERROR,
  TERMINAL_PREVIEW_STATUSES,
  type PreviewRequestPayload,
} from '@/lib/preview-run';
import { runPreview, validatePreviewPayload } from '@/lib/preview-runner';
import type { Airport } from '@/lib/scraper/parse-query';

const PREVIEW_RUN_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Independent heartbeat cadence. Belt and suspenders alongside the per
 * task onTaskComplete heartbeat: if a single updatePreviewRun write
 * fails or stalls, this interval still bumps updatedAt within
 * HEARTBEAT_INTERVAL_MS, keeping the GET stale marker from falsely
 * failing a healthy long scrape. Cadence well under
 * PREVIEW_ACTIVE_TIMEOUT_MS (30 min).
 */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

interface PreviewRunRow {
  id: string;
  requestHash: string;
  status: string;
  requestPayload: Prisma.JsonValue;
  resultPayload: Prisma.JsonValue | null;
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface PreviewRunStore {
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<PreviewRunRow>;
  findFirst(args: { where: Record<string, unknown>; orderBy: { createdAt: 'desc' } }): Promise<PreviewRunRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<PreviewRunRow>;
}

const previewRunStore = (prisma as unknown as { previewRun: PreviewRunStore }).previewRun;

function buildPreviewRequestHash(payload: PreviewRequestPayload): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function toPreviewRequestPayload(body: Record<string, unknown>): PreviewRequestPayload {
  const origins: Airport[] = Array.isArray(body.origins)
    ? body.origins as Airport[]
    : body.origin ? [{ code: String(body.origin), name: String(body.originName || body.origin) }] : [];
  const destinations: Airport[] = Array.isArray(body.destinations)
    ? body.destinations as Airport[]
    : body.destination ? [{ code: String(body.destination), name: String(body.destinationName || body.destination) }] : [];

  return {
    dateFrom: String(body.dateFrom || ''),
    dateTo: String(body.dateTo || ''),
    maxPrice: body.maxPrice === undefined || body.maxPrice === null ? null : Number(body.maxPrice),
    maxStops: body.maxStops === undefined || body.maxStops === null ? null : Number(body.maxStops),
    maxDurationHours: body.maxDurationHours === undefined || body.maxDurationHours === null ? null : Number(body.maxDurationHours),
    preferredAirlines: Array.isArray(body.preferredAirlines) ? body.preferredAirlines.map(String) : [],
    timePreference: typeof body.timePreference === 'string' ? body.timePreference : 'any',
    cabinClass: typeof body.cabinClass === 'string' ? body.cabinClass : 'economy',
    tripType: typeof body.tripType === 'string' ? body.tripType : 'round_trip',
    currency: typeof body.currency === 'string' && body.currency ? body.currency : null,
    outboundDates: Array.isArray(body.outboundDates) ? body.outboundDates.map(String) : undefined,
    returnDates: Array.isArray(body.returnDates) ? body.returnDates.map(String) : undefined,
    origins: origins.map((airport) => ({ code: airport.code, name: airport.name })),
    destinations: destinations.map((airport) => ({ code: airport.code, name: airport.name })),
    origin: typeof body.origin === 'string' ? body.origin : undefined,
    originName: typeof body.originName === 'string' ? body.originName : undefined,
    destination: typeof body.destination === 'string' ? body.destination : undefined,
    destinationName: typeof body.destinationName === 'string' ? body.destinationName : undefined,
  };
}

async function cleanupExpiredPreviewRuns(now = new Date()) {
  await previewRunStore.deleteMany({
    where: {
      status: { in: [...TERMINAL_PREVIEW_STATUSES] },
      expiresAt: { lt: now },
    },
  });
}

async function markStalePreviewRunsFailed(requestHash?: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - PREVIEW_ACTIVE_TIMEOUT_MS);
  await previewRunStore.updateMany({
    where: {
      status: { in: [...ACTIVE_PREVIEW_STATUSES] },
      updatedAt: { lt: staleBefore },
      ...(requestHash ? { requestHash } : {}),
    },
    data: {
      status: 'failed',
      error: PREVIEW_TIMEOUT_ERROR,
    },
  });
}

async function updatePreviewRun(id: string, data: Record<string, unknown>) {
  try {
    await previewRunStore.update({
      where: { id },
      data,
    });
  } catch (error) {
    console.error(`[preview] failed to update preview run ${id}`, error);
  }
}

async function runPreviewInBackground(id: string, payload: PreviewRequestPayload) {
  await updatePreviewRun(id, { status: 'running', error: null });

  // Independent timer based heartbeat. Audit finding A2: the per task
  // onTaskComplete heartbeat is the primary signal, but a single task
  // can run for tens of seconds (Playwright launch + LLM extract) and
  // any single updatePreviewRun call can fail transiently. A timer
  // running at HEARTBEAT_INTERVAL_MS guarantees updatedAt advances even
  // if those signals stall, so the stale marker in [id]/route.ts and
  // markStalePreviewRunsFailed cannot falsely fail a healthy run.
  const heartbeatTimer = setInterval(() => {
    void updatePreviewRun(id, { status: 'running' });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const result = await runPreview(payload, {
      onTaskComplete: () => updatePreviewRun(id, { status: 'running' }),
    });
    clearInterval(heartbeatTimer);
    await updatePreviewRun(id, {
      status: 'completed',
      resultPayload: result as unknown as Prisma.InputJsonValue,
      error: null,
      expiresAt: new Date(Date.now() + PREVIEW_RUN_TTL_MS),
    });
  } catch (error) {
    clearInterval(heartbeatTimer);
    await updatePreviewRun(id, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Failed to preview flights',
      expiresAt: new Date(Date.now() + PREVIEW_RUN_TTL_MS),
    });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const payload = toPreviewRequestPayload(body as Record<string, unknown>);

  try {
    validatePreviewPayload(payload);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid preview request', 400);
  }

  const requestHash = buildPreviewRequestHash(payload);
  const now = new Date();

  await cleanupExpiredPreviewRuns(now);
  await markStalePreviewRunsFailed(requestHash, now);

  const existingRun = await previewRunStore.findFirst({
    where: {
      requestHash,
      status: { in: [...ACTIVE_PREVIEW_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existingRun) {
    return apiSuccess({
      previewRunId: existingRun.id,
      status: existingRun.status,
      expiresAt: existingRun.expiresAt.toISOString(),
    }, 202);
  }

  const previewRun = await previewRunStore.create({
    data: {
      requestHash,
      status: 'pending',
      requestPayload: payload as unknown as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + PREVIEW_RUN_TTL_MS),
    },
  });

  void runPreviewInBackground(previewRun.id, payload);

  return apiSuccess({
    previewRunId: previewRun.id,
    status: previewRun.status,
    expiresAt: previewRun.expiresAt.toISOString(),
  }, 202);
}
