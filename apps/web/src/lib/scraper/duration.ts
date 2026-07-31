/**
 * Parse a human duration string like "11h 20m" or "2h" into total minutes.
 * Returns null when the string contains neither hours nor minutes (e.g. empty,
 * null, or unrecognized formats like "PT12H30M"). Callers treat null as
 * "unparseable, do not filter on it".
 */
export function parseDurationToMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (!h && !m) return null;
  const hours = h ? parseInt(h[1]!, 10) : 0;
  const mins = m ? parseInt(m[1]!, 10) : 0;
  return hours * 60 + mins;
}

/** Render minutes back into the "11h 20m" form the rest of the app uses. */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** One connection on an itinerary, in travel order. */
export type Layover = {
  duration: string; // normalized, e.g. "1h 35m"
  airport: string | null; // IATA code or city as shown, e.g. "ORD"
};

// A one-stop itinerary has one layover; the cap is a sanity bound on model
// output, not a real-world limit anyone will hit.
const MAX_LAYOVERS = 6;
const MAX_AIRPORT_LENGTH = 40;

/**
 * Parse the layover line Google Flights renders per itinerary, e.g.
 * "1 hr 35 min layover · Chicago ORD" or "55 min in ATL". The duration is
 * whatever precedes the separator; anything after it is the connection point.
 */
function parseLayoverText(text: string): Layover | null {
  const [durationPart, ...rest] = text.split(/·|\||\bin\b|\bat\b/i);
  const minutes = parseDurationToMinutes(durationPart);
  if (minutes === null || minutes <= 0) return null;
  const airport = rest
    .join(' ')
    .replace(/layover|connection|stop/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { duration: formatMinutes(minutes), airport: airport ? airport.slice(0, MAX_AIRPORT_LENGTH) : null };
}

/**
 * Normalize whatever a model (or a client POST, or a Prisma Json column) offers
 * as layovers into a clean `Layover[]`, or null when nothing usable is there.
 *
 * This is the single trust boundary for the field: the same tolerance the rest
 * of extraction applies to loosely-typed model output (see normalizeEntry in
 * extract-prices.ts), and what bounds client-supplied values before they reach
 * the database. Accepted shapes: an array of objects, an array of raw layover
 * strings, or a single string/object for a one-stop itinerary.
 */
export function coerceLayovers(value: unknown): Layover[] | null {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const out: Layover[] = [];
  for (const item of items) {
    if (out.length >= MAX_LAYOVERS) break;
    if (typeof item === 'string') {
      const parsed = parseLayoverText(item);
      if (parsed) out.push(parsed);
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const rawDuration = e.duration ?? e.layoverDuration ?? e.layover ?? e.time ?? e.length;
    const minutes =
      typeof rawDuration === 'number' && Number.isFinite(rawDuration)
        ? Math.trunc(rawDuration)
        : parseDurationToMinutes(typeof rawDuration === 'string' ? rawDuration : null);
    if (minutes === null || minutes <= 0) continue;
    const rawAirport = e.airport ?? e.airportCode ?? e.code ?? e.city ?? e.location;
    out.push({
      duration: formatMinutes(minutes),
      airport:
        typeof rawAirport === 'string' && rawAirport.trim()
          ? rawAirport.trim().slice(0, MAX_AIRPORT_LENGTH)
          : null,
    });
  }
  return out.length > 0 ? out : null;
}

/** Total time on the ground across all connections, or null when unknown. */
export function layoverMinutes(value: unknown): number | null {
  const layovers = coerceLayovers(value);
  if (!layovers) return null;
  return layovers.reduce((sum, l) => sum + (parseDurationToMinutes(l.duration) ?? 0), 0);
}

/**
 * Time actually in the air: gate-to-gate duration minus every layover. Null
 * when either side is unknown, or when the two disagree (a layover total at or
 * above the trip duration means one of them was misread, and a negative air
 * time is worse than no air time).
 */
export function airTimeMinutes(duration: string | null | undefined, layovers: unknown): number | null {
  const total = parseDurationToMinutes(duration);
  const ground = layoverMinutes(layovers);
  if (total === null || ground === null || ground <= 0 || ground >= total) return null;
  return total - ground;
}

/** "1h 35m ORD" / "2h 10m" — compact label for the total ground time. */
export function layoverLabel(value: unknown): string | null {
  const layovers = coerceLayovers(value);
  const minutes = layoverMinutes(value);
  if (!layovers || minutes === null || minutes <= 0) return null;
  const airports = layovers.map((l) => l.airport).filter((a): a is string => !!a);
  return airports.length > 0 ? `${formatMinutes(minutes)} ${airports.join(', ')}` : formatMinutes(minutes);
}
