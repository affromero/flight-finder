// CLI shim for `@/lib/limits`. The shared scraper (apps/web's
// extract-prices.ts) imports `@/lib/limits` to bound coerced prices. Under
// the CLI's tsconfig (`@/*` -> ./src/*) that bare import would not resolve,
// so re-export the real implementation here. tsup's `@` -> apps/web/src
// alias inlines the same module at build time, and the dev loader resolves
// this relative path to it. Same shim role as ./prisma.ts and ./redis.ts.
export { MAX_PRICE_VALUE, isValidPriceAmount } from '../../../../apps/web/src/lib/limits.js';
