import { apiError, apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import {
  ACTIVE_PREVIEW_STATUSES,
  PREVIEW_ACTIVE_TIMEOUT_MS,
  PREVIEW_TIMEOUT_ERROR,
  type PreviewResultPayload,
  type PreviewRunStatusPayload,
} from '@/lib/preview-run';

const ACTIVE_STATUS_SET = new Set<string>(ACTIVE_PREVIEW_STATUSES);
const TERMINAL_STATUS_SET = new Set(['completed', 'failed']);

interface PreviewRunRow {
  id: string;
  status: string;
  resultPayload: unknown;
  error: string | null;
  expiresAt: Date;
  updatedAt: Date;
}

interface PreviewRunStore {
  findUnique(args: { where: { id: string } }): Promise<PreviewRunRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

const previewRunStore = (prisma as unknown as { previewRun: PreviewRunStore }).previewRun;

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const notFound = () => {
    const response = apiError('Preview run not found or expired', 404);
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    return response;
  };

  const { id } = await context.params;

  let previewRun = await previewRunStore.findUnique({
    where: { id },
  });

  if (!previewRun) {
    return notFound();
  }

  // Stale-marker with race guard. Between the findUnique above and any
  // subsequent update, runPreviewInBackground can flip the row to completed
  // or failed. A naive update by id alone would overwrite that terminal
  // state with our stale-failed marker. updateMany with status + updatedAt
  // in the where clause is atomic: if the row already moved out of the
  // ACTIVE set, the update affects zero rows and we just return the latest
  // state. The heartbeat in runPreview shrinks the time window further by
  // bumping updatedAt every task.
  if (
    ACTIVE_STATUS_SET.has(previewRun.status) &&
    previewRun.updatedAt.getTime() <= Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS
  ) {
    const staleBefore = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS);
    await previewRunStore.updateMany({
      where: {
        id,
        status: { in: [...ACTIVE_PREVIEW_STATUSES] },
        updatedAt: { lt: staleBefore },
      },
      data: {
        status: 'failed',
        error: PREVIEW_TIMEOUT_ERROR,
      },
    });
    const refreshed = await previewRunStore.findUnique({ where: { id } });
    if (!refreshed) return notFound();
    previewRun = refreshed;
  }

  if (TERMINAL_STATUS_SET.has(previewRun.status) && isExpired(previewRun.expiresAt)) {
    return notFound();
  }

  const response: PreviewRunStatusPayload = {
    id: previewRun.id,
    status: previewRun.status as PreviewRunStatusPayload['status'],
    result: previewRun.resultPayload as PreviewResultPayload | null,
    error: previewRun.error,
    expiresAt: previewRun.expiresAt.toISOString(),
  };

  const apiResponse = apiSuccess(response);
  apiResponse.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return apiResponse;
}
