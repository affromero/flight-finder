// Single source of truth for cabin class values. Deliberately dependency-free:
// imported by API routes, the shared scraper (parse-query.ts), and the CLI via
// its packages/cli/src/lib shim, so it must not drag in prisma/redis/ai-registry.
export const CABIN_CLASSES = ['economy', 'premium_economy', 'business', 'first'] as const;

export type CabinClass = (typeof CABIN_CLASSES)[number];

export const ALLOWED_CABIN_CLASSES: ReadonlySet<string> = new Set(CABIN_CLASSES);

/** True when the value is exactly a valid cabin class string (no coercion). */
export function isCabinClass(value: unknown): value is CabinClass {
  return typeof value === 'string' && ALLOWED_CABIN_CLASSES.has(value);
}

/**
 * Clamp an untrusted value (LLM output, request body) to a valid cabin class.
 * Tolerates realistic model drift ("Business", " premium economy ",
 * "premium-economy"); anything unrecognized falls back to 'economy'.
 */
export function normalizeCabinClass(value: unknown): CabinClass {
  if (typeof value !== 'string') return 'economy';
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALLOWED_CABIN_CLASSES.has(v) ? (v as CabinClass) : 'economy';
}
