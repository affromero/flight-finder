export type ScrapeStatus = 'in_progress' | 'success' | 'partial' | 'failed';

export interface SiblingScrape {
  status: ScrapeStatus | string | null;
  error: string | null;
  startedAt: string | null;
}

export interface AggregatedScrape {
  status: ScrapeStatus | null;
  error: string | null;
  startedAt: string | null;
  failingSiblings: number;
}

const ORDER: ScrapeStatus[] = ['in_progress', 'failed', 'partial', 'success'];

function normalize(value: ScrapeStatus | string | null): ScrapeStatus | null {
  if (value === 'in_progress' || value === 'success' || value === 'partial' || value === 'failed') {
    return value;
  }
  return null;
}

/**
 * Pick the "most attention worthy" status across siblings.
 *
 * Order: in_progress > failed > partial > success > null.
 * Rationale: an active scrape always wins so the dot pulses while the
 * refresh is in flight; otherwise we surface the worst terminal state so a
 * single failing sibling can't hide behind successful ones.
 *
 * `error` follows the picked status (first matching sibling). `startedAt`
 * is the most recent across siblings regardless of status, so the tooltip
 * timestamp always reflects when something last happened.
 */
export function aggregateScrapeStatus(siblings: SiblingScrape[]): AggregatedScrape {
  if (siblings.length === 0) {
    return { status: null, error: null, startedAt: null, failingSiblings: 0 };
  }

  let mostRecent: string | null = null;
  let failingSiblings = 0;
  for (const s of siblings) {
    if (s.startedAt && (mostRecent === null || s.startedAt > mostRecent)) {
      mostRecent = s.startedAt;
    }
    if (normalize(s.status) === 'failed') failingSiblings += 1;
  }

  for (const want of ORDER) {
    const match = siblings.find((s) => normalize(s.status) === want);
    if (match) {
      return {
        status: want,
        error: match.error,
        startedAt: mostRecent,
        failingSiblings,
      };
    }
  }

  return { status: null, error: null, startedAt: mostRecent, failingSiblings: 0 };
}
