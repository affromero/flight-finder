// CLI shim for `@/lib/secret-crypto`. The shared scraper (apps/web's
// ai-registry.ts) imports `@/lib/secret-crypto` to decrypt DB-stored provider
// keys (#149). Under the CLI's tsconfig (`@/*` -> ./src/*) that bare import
// would not resolve, so re-export the real implementation here. tsup's
// `@` -> apps/web/src alias inlines the same module at build time, and the dev
// loader resolves this relative path to it — so the behavior is always the
// real crypto, never a stub. Same shim role as ./prisma.ts and ./redis.ts.
export { encryptSecret, decryptSecret } from '../../../../apps/web/src/lib/secret-crypto.js';
