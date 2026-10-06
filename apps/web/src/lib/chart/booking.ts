import { safeHttpUrl } from '@/lib/safe-url';

interface ChartClick {
  points?: { customdata?: unknown; bbox?: { x0: number; x1: number; y0: number; y1: number } }[];
  event?: { clientX: number; clientY: number };
}

/** Unified hover includes other flights. Only the uniquely nearest price is clicked. */
export function clickedBookingUrl(event: ChartClick): string | null {
  const points = event.points ?? [];
  let point = points[0];
  if (points.length > 1) {
    const pointer = event.event;
    if (!pointer || !Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return null;
    if (points.some(candidate => !candidate.bbox || !Object.values(candidate.bbox).every(Number.isFinite))) return null;
    const ranked = points.map(candidate => {
      const box = candidate.bbox!;
      return { point: candidate, distance: Math.hypot((box.x0 + box.x1) / 2 - pointer.clientX, (box.y0 + box.y1) / 2 - pointer.clientY) };
    })
      .sort((a, b) => a.distance - b.distance);
    if (!ranked[0] || ranked[0].distance === ranked[1]?.distance) return null;
    point = ranked[0].point;
  }
  const value: unknown = Array.isArray(point?.customdata) ? point.customdata[0] : null;
  return typeof value === 'string' ? safeHttpUrl(value) : null;
}
