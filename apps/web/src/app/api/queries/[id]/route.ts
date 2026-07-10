import { NextRequest } from 'next/server';
import type { Prisma } from '@/generated/prisma/client';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { authorizeMutation } from '@/lib/query-auth';
import { getCurrentUser } from '@/lib/user-auth';
import { isAggregatorSource } from '@/lib/scraper/navigate';
import { isValidPriceAmount } from '@/lib/limits';

const ALLOWED_INTERVALS = [1, 3, 6, 12, 24];
const MAX_STOPS_VALUE = 10;
const MAX_AIRLINE_LENGTH = 100;

type TrackerEditValue = string | number | boolean | string[] | null;
type TrackerEditField =
  | 'maxPrice'
  | 'maxStops'
  | 'maxDurationHours'
  | 'preferredAirlines';

interface EditableQuery {
  id: string;
  deleteToken: string | null;
  groupId: string | null;
  userId: string | null;
  maxPrice: number | null;
  maxStops: number | null;
  maxDurationHours: number | null;
  preferredAirlines: string[];
  preferredAggregators: string[];
}

interface TrackerEditChange {
  field: TrackerEditField;
  label: string;
  before: TrackerEditValue;
  after: TrackerEditValue;
  beforeLabel: string;
  afterLabel: string;
}

interface QueryEditEventCreate {
  queryId: string;
  editedAt: Date;
  userId: string | null;
  summary: string;
  changes: Prisma.InputJsonValue;
}

const EDIT_FIELD_LABELS: Record<TrackerEditField, string> = {
  maxPrice: 'Max price',
  maxStops: 'Stops',
  maxDurationHours: 'Max duration',
  preferredAirlines: 'Airlines',
};

function hasOwn(body: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function editValuesEqual(before: TrackerEditValue, after: TrackerEditValue): boolean {
  if (Array.isArray(before) && Array.isArray(after)) return stringArraysEqual(before, after);
  return before === after;
}

function normalizeEditValue(field: TrackerEditField, value: unknown): TrackerEditValue {
  if (field === 'preferredAirlines') {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function formatEditValue(field: TrackerEditField, value: TrackerEditValue): string {
  if (value === null) {
    if (field === 'maxStops' || field === 'maxPrice' || field === 'maxDurationHours') return 'Any';
    return 'None';
  }
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'Any';

  switch (field) {
    case 'maxPrice':
      return `Under ${value}`;
    case 'maxStops':
      return value === 0 ? 'Nonstop only' : `Max ${value} stop${value === 1 ? '' : 's'}`;
    case 'maxDurationHours':
      return `Under ${value}h`;
    case 'preferredAirlines':
      return String(value);
  }
}

function buildEditChanges(
  target: EditableQuery,
  data: Partial<Record<TrackerEditField, TrackerEditValue>>,
): TrackerEditChange[] {
  const changes: TrackerEditChange[] = [];
  for (const field of Object.keys(data) as TrackerEditField[]) {
    const after = normalizeEditValue(field, data[field]);
    const before = normalizeEditValue(field, target[field]);
    if (editValuesEqual(before, after)) continue;
    changes.push({
      field,
      label: EDIT_FIELD_LABELS[field],
      before,
      after,
      beforeLabel: formatEditValue(field, before),
      afterLabel: formatEditValue(field, after),
    });
  }
  return changes;
}

function summarizeChanges(changes: TrackerEditChange[]): string {
  if (changes.length === 1) {
    const change = changes[0]!;
    if (change.field === 'maxStops' && change.after === 0) return 'Nonstop only enabled';
    return `${change.label} changed`;
  }
  return `${changes.length} tracker filters changed`;
}

function changesToJson(changes: TrackerEditChange[]): Prisma.InputJsonObject {
  return {
    changes: changes.map((change): Prisma.InputJsonObject => ({
      field: change.field,
      label: change.label,
      before: change.before,
      after: change.after,
      beforeLabel: change.beforeLabel,
      afterLabel: change.afterLabel,
    })),
  };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;

  const query = await prisma.query.findUnique({
    where: { id },
    select: {
      id: true,
      deleteToken: true,
      groupId: true,
      userId: true,
      maxPrice: true,
      maxStops: true,
      maxDurationHours: true,
      preferredAirlines: true,
      preferredAggregators: true,
    },
  });

  if (!query) return apiError('Tracker not found', 404);

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);
  const primaryTarget: EditableQuery = { ...query, id };

  // Group-cascading fields: applied to every sibling in the group via updateMany.
  const cascadeData: {
    scrapeInterval?: number | null;
    active?: boolean;
    maxPrice?: number | null;
    maxStops?: number | null;
    maxDurationHours?: number | null;
    preferredAirlines?: string[];
  } = {};
  // Per-row fields: applied only to the single id. preferredAggregators is
  // intentionally NOT cascaded — different siblings in a flex group can sit on
  // different aggregators (e.g. one experimental, one default).
  const singleRowData: { preferredAggregators?: string[]; label?: string | null } = {};

  if (body && hasOwn(body, 'scrapeInterval')) {
    let interval: number | null;
    if (body.scrapeInterval === null) {
      interval = null;
    } else {
      interval = Number(body.scrapeInterval);
      if (!ALLOWED_INTERVALS.includes(interval)) {
        return apiError(`scrapeInterval must be null or one of: ${ALLOWED_INTERVALS.join(', ')}`, 400);
      }
    }
    cascadeData.scrapeInterval = interval;
  }

  if (body && hasOwn(body, 'active')) {
    if (typeof body.active !== 'boolean') {
      return apiError('active must be a boolean', 400);
    }
    cascadeData.active = body.active;
  }

  if (body && hasOwn(body, 'maxPrice')) {
    if (body.maxPrice === null) {
      cascadeData.maxPrice = null;
    } else {
      const maxPrice = Number(body.maxPrice);
      if (!isValidPriceAmount(maxPrice)) {
        return apiError('maxPrice must be null or a finite non-negative number', 400);
      }
      cascadeData.maxPrice = maxPrice;
    }
  }

  if (body && hasOwn(body, 'maxStops')) {
    if (body.maxStops === null) {
      cascadeData.maxStops = null;
    } else {
      const maxStops = Number(body.maxStops);
      if (!Number.isInteger(maxStops) || maxStops < 0 || maxStops > MAX_STOPS_VALUE) {
        return apiError(`maxStops must be null or an integer between 0 and ${MAX_STOPS_VALUE}`, 400);
      }
      cascadeData.maxStops = maxStops;
    }
  }

  if (body && hasOwn(body, 'maxDurationHours')) {
    if (body.maxDurationHours === null) {
      cascadeData.maxDurationHours = null;
    } else {
      const maxDurationHours = Number(body.maxDurationHours);
      if (!Number.isInteger(maxDurationHours) || maxDurationHours < 1 || maxDurationHours > 48) {
        return apiError('maxDurationHours must be null or an integer between 1 and 48', 400);
      }
      cascadeData.maxDurationHours = maxDurationHours;
    }
  }

  if (body && hasOwn(body, 'preferredAirlines')) {
    if (!Array.isArray(body.preferredAirlines)) {
      return apiError('preferredAirlines must be an array of strings', 422);
    }
    const airlines: string[] = [];
    for (const airline of body.preferredAirlines) {
      if (typeof airline !== 'string') {
        return apiError('preferredAirlines must be an array of strings', 422);
      }
      const trimmed = airline.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_AIRLINE_LENGTH) {
        return apiError(`preferredAirlines entry must be ${MAX_AIRLINE_LENGTH} characters or fewer`, 400);
      }
      airlines.push(trimmed);
    }
    cascadeData.preferredAirlines = airlines;
  }

  if (body && hasOwn(body, 'label')) {
    if (body.label === null) {
      singleRowData.label = null;
    } else if (typeof body.label === 'string') {
      const trimmed = body.label.trim();
      if (trimmed.length > 60) {
        return apiError('label must be 60 characters or fewer', 400);
      }
      singleRowData.label = trimmed || null;
    } else {
      return apiError('label must be a string or null', 400);
    }
  }

  if (body && hasOwn(body, 'preferredAggregators')) {
    if (!Array.isArray(body.preferredAggregators)) {
      return apiError('preferredAggregators must be an array of strings', 422);
    }
    for (const a of body.preferredAggregators) {
      if (!isAggregatorSource(a)) {
        return apiError(`preferredAggregators contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    singleRowData.preferredAggregators = body.preferredAggregators;
  }

  if (Object.keys(cascadeData).length === 0 && Object.keys(singleRowData).length === 0) {
    return apiError('No updatable fields supplied', 400);
  }

  const cascadeTargets: EditableQuery[] = [primaryTarget];
  if (query.groupId && Object.keys(cascadeData).length > 0) {
    const siblings = await prisma.query.findMany({
      where: { groupId: query.groupId, id: { not: id } },
      select: {
        id: true,
        deleteToken: true,
        groupId: true,
        userId: true,
        maxPrice: true,
        maxStops: true,
        maxDurationHours: true,
        preferredAirlines: true,
        preferredAggregators: true,
      },
    });
    cascadeTargets.push(...siblings);
  }
  const idsToUpdate = cascadeTargets.map((target) => target.id);

  const eventData: Partial<Record<TrackerEditField, TrackerEditValue>> = {};
  if (hasOwn(cascadeData, 'maxPrice')) eventData.maxPrice = cascadeData.maxPrice ?? null;
  if (hasOwn(cascadeData, 'maxStops')) eventData.maxStops = cascadeData.maxStops ?? null;
  if (hasOwn(cascadeData, 'maxDurationHours')) eventData.maxDurationHours = cascadeData.maxDurationHours ?? null;
  if (hasOwn(cascadeData, 'preferredAirlines')) eventData.preferredAirlines = cascadeData.preferredAirlines ?? [];

  const editedAt = new Date();
  const user = await getCurrentUser().catch(() => null);
  const events: QueryEditEventCreate[] = [];
  for (const target of cascadeTargets) {
    const changes = buildEditChanges(target, eventData);
    if (changes.length === 0) continue;
    events.push({
      queryId: target.id,
      editedAt,
      userId: user?.id ?? null,
      summary: summarizeChanges(changes),
      changes: changesToJson(changes),
    });
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(cascadeData).length > 0) {
      await tx.query.updateMany({
        where: { id: { in: idsToUpdate } },
        data: cascadeData,
      });
    }

    if (Object.keys(singleRowData).length > 0) {
      await tx.query.update({
        where: { id },
        data: singleRowData,
      });
    }

    if (events.length > 0) {
      await tx.queryEditEvent.createMany({ data: events });
    }
  });

  return apiSuccess({ ...cascadeData, ...singleRowData, updated: idsToUpdate.length });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;
  const groupDelete = body?.groupDelete === true;

  const query = await prisma.query.findUnique({
    where: { id },
    select: { deleteToken: true, groupId: true, userId: true },
  });

  if (!query) {
    return apiError('Tracker not found', 404);
  }

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);

  if (groupDelete && query.groupId) {
    const result = await prisma.query.deleteMany({ where: { groupId: query.groupId } });
    return apiSuccess({ deleted: true, groupDeleted: true, count: result.count });
  }

  await prisma.query.delete({ where: { id } });

  return apiSuccess({ deleted: true, groupDeleted: false });
}
