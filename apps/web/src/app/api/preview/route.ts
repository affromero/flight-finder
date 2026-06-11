import { createHash } from 'crypto';
import type { Prisma } from '@/generated/prisma/client';
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { getClientIp } from '@/lib/trusted-ip';
import {
  ACTIVE_PREVIEW_STATUSES,
  PREVIEW_ACTIVE_TIMEOUT_MS,
  PREVIEW_TIMEOUT_ERROR,
  TERMINAL_PREVIEW_STATUSES,
  type PreviewRequestPayload,
} from '@/lib/preview-run';
import {
  acquirePreviewAdmission,
  releasePreviewAdmission,
  runPreview,
  validatePreviewPayload,
} from '@/lib/preview-runner';
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

/**
 * Cap on concurrent active previews per source IP. Audit finding D2:
 * without this, one client can spawn unbounded background scrapes by
 * issuing distinct queries fast. The count query filters by clientIp,
 * active status, AND fresh updatedAt, so stale rows do not block
 * admission even if the background sweep has not run yet.
 */
const PREVIEW_ADMISSION_CAP = (() => {
  const raw = process.env.PREVIEW_ADMISSION_CAP;
  if (raw === undefined) return 3;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.min(parsed, 50);
})();

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

interface BackgroundPreviewOptions {
  concurrency?: number;
  /**
   * Client IP whose Redis admission slot this run holds. Always present for an
   * admitted run, since admission is now Redis only (no DB count fallback). The
   * slot is released exactly once when the run reaches a terminal state
   * (completed or failed) so the client's concurrent quota frees up.
   */
  releaseIp?: string;
}

async function runPreviewInBackground(
  id: string,
  payload: PreviewRequestPayload,
  options: BackgroundPreviewOptions = {},
) {
  const { concurrency, releaseIp } = options;
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
      concurrency,
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
  } finally {
    // Free the admission slot the moment this run can no longer be in
    // flight, so the client's concurrent quota recovers without waiting on
    // the TTL. Runs in a finally so an unexpected throw from either branch
    // above still releases.
    if (releaseIp) {
      await releasePreviewAdmission(releaseIp);
    }
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const payload = toPreviewRequestPayload(body as Record<string, unknown>);

  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { previewMaxCombos: true, previewAdmissionCap: true, previewConcurrency: true },
  });

  try {
    validatePreviewPayload(payload, config?.previewMaxCombos ?? 24);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid preview request', 400);
  }

  const requestHash = buildPreviewRequestHash(payload);
  const now = new Date();
  const clientIp = getClientIp(request);

  // Audit finding B4: cleanup and stale sweep used to block the
  // request. Both are now fire and forget; admission counting filters
  // by fresh updatedAt so stale rows that have not yet been swept do
  // not falsely count against the cap.
  void cleanupExpiredPreviewRuns(now).catch((err) =>
    console.error('[preview] cleanupExpiredPreviewRuns failed', err)
  );
  void markStalePreviewRunsFailed(requestHash, now).catch((err) =>
    console.error('[preview] markStalePreviewRunsFailed failed', err)
  );

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

  // Audit finding D2/M5: cap concurrent active previews per source IP.
  // Admin-configured cap wins over the env/default, clamped to a safe ceiling.
  const admissionCap =
    config?.previewAdmissionCap != null && config.previewAdmissionCap > 0
      ? Math.min(config.previewAdmissionCap, 50)
      : PREVIEW_ADMISSION_CAP;

  // Audit finding M5/B/F: the old gate read previewRunStore.count then, outside
  // any transaction, ran create. N concurrent requests all observed the
  // pre-insert count and slipped past the cap. The Redis counter is an atomic
  // admission gate run as a single Lua script (INCR + cap + EXPIRE + overshoot
  // rollback), so at most `admissionCap` of a burst are admitted and no partial
  // failure can leak a slot. The slot is released in runPreviewInBackground
  // when the run settles.
  //
  // The gate always runs, including for the 'unknown' bucket that getClientIp
  // returns when no trusted proxy is asserted (TRUSTED_FORWARDED_FOR=false) or
  // no forwarded header is present (audit finding B). Skipping it there would
  // let a caller bypass the cap by simply omitting the header. All unknown-IP
  // callers share one bucket, so the cap still binds them collectively.
  //
  // On any Redis problem the gate fails CLOSED (rejected): there is no DB count
  // fallback, because that non atomic read then create reopens the TOCTOU race
  // (audit finding F). A preview is a background scrape, so denying admission
  // during a Redis outage is the safe default.
  const admission = await acquirePreviewAdmission(clientIp, admissionCap);
  if (admission === 'rejected') {
    return apiError(
      `Too many active previews for this client (cap ${admissionCap}). Wait for one to finish or try again later.`,
      429,
    );
  }
  // Admission succeeded, so a Redis slot is reserved for clientIp. From here
  // exactly one releasePreviewAdmission(clientIp) must run on every path: the
  // background runner releases it when the run settles, and the create-failed
  // path below releases it directly since that run never starts.
  let previewRun: PreviewRunRow;
  try {
    previewRun = await previewRunStore.create({
      data: {
        requestHash,
        status: 'pending',
        requestPayload: payload as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + PREVIEW_RUN_TTL_MS),
        clientIp,
      },
    });
  } catch (error) {
    // The row never persisted, so the background runner will never run to
    // release the reserved slot. Release it here to avoid leaking quota.
    await releasePreviewAdmission(clientIp);
    throw error;
  }

  void runPreviewInBackground(previewRun.id, payload, {
    concurrency: config?.previewConcurrency ?? undefined,
    releaseIp: clientIp,
  });

  return apiSuccess({
    previewRunId: previewRun.id,
    status: previewRun.status,
    expiresAt: previewRun.expiresAt.toISOString(),
  }, 202);
}
