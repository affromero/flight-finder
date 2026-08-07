// CLI shim for `@/lib/cabin-class`. The shared scraper (apps/web's
// parse-query.ts) imports `@/lib/cabin-class` to clamp LLM-emitted cabin
// values. Under the CLI's tsconfig (`@/*` -> ./src/*) that bare import would
// not resolve, so re-export the real implementation here. Same shim role as
// ./prisma.ts and ./secret-crypto.ts.
export {
  CABIN_CLASSES,
  ALLOWED_CABIN_CLASSES,
  isCabinClass,
  normalizeCabinClass,
} from '../../../../apps/web/src/lib/cabin-class.js';
export type { CabinClass } from '../../../../apps/web/src/lib/cabin-class.js';
