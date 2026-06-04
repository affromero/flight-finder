/**
 * Provider keyed sliding window rate limiter for LLM extract calls.
 * Issue 65 audit finding D3: with PREVIEW_CONCURRENCY=3 plus the
 * retry-on-llm_error path, a 20 route preview could burst past free
 * tier per minute caps (notably Gemini at 15 RPM). The acquire helper
 * blocks just long enough to keep the rolling 60 second window under
 * the configured limit, smoothing bursts instead of failing them.
 *
 * Sliding window is preferred over a fixed token bucket because the
 * relevant limits (Gemini free, Anthropic Tier 1) are quoted as
 * requests per minute, not per second.
 *
 * Limits are read from env at module load. Default values reflect the
 * conservative free tier caps; production deployments should override
 * with the operator's actual quota. Override knobs:
 *   GOOGLE_RPM (default 15, Gemini free tier)
 *   ANTHROPIC_RPM (default 50)
 *   OPENAI_RPM (default 60)
 *   GROQ_RPM (default 30)
 * Local providers (ollama, llamacpp, vllm) and CLI providers
 * (claude-code, codex, gemini) skip the limiter entirely; they are
 * either local or have their own provider side throttles.
 */

import { prisma } from '@/lib/prisma';

const UNLIMITED = Number.POSITIVE_INFINITY;

function readRpm(envName: string, defaultRpm: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return defaultRpm;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultRpm;
  return parsed;
}

const PROVIDER_RPM: Record<string, number> = {
  google: readRpm('GOOGLE_RPM', 15),
  anthropic: readRpm('ANTHROPIC_RPM', 50),
  openai: readRpm('OPENAI_RPM', 60),
  groq: readRpm('GROQ_RPM', 30),
  ollama: UNLIMITED,
  llamacpp: UNLIMITED,
  vllm: UNLIMITED,
  // CLI providers run a subprocess; their own quotas govern, not ours.
  'claude-code': UNLIMITED,
  codex: UNLIMITED,
  gemini: UNLIMITED,
};

const WINDOW_MS = 60_000;
const timestampsByProvider = new Map<string, number[]>();

// Admin-configured per-provider RPM overrides (ExtractionConfig), cached 60s so
// the hot extract path does not hit the DB on every call. Precedence:
// DB override > env (baked into PROVIDER_RPM) > built-in default. On any DB
// error we fall back to the env/default values, preserving current behavior.
const RPM_CACHE_TTL_MS = 60_000;
let rpmOverrideCache: { value: Record<string, number | null>; expiresAt: number } | null = null;

async function getRpmOverrides(): Promise<Record<string, number | null>> {
  const now = Date.now();
  if (rpmOverrideCache && rpmOverrideCache.expiresAt > now) return rpmOverrideCache.value;

  let value: Record<string, number | null> = {};
  try {
    const config = await prisma.extractionConfig.findFirst({
      where: { id: 'singleton' },
      select: { anthropicRpm: true, googleRpm: true, openaiRpm: true, groqRpm: true },
    });
    if (config) {
      value = {
        anthropic: config.anthropicRpm,
        google: config.googleRpm,
        openai: config.openaiRpm,
        groq: config.groqRpm,
      };
    }
  } catch {
    // DB unavailable — leave overrides empty so env/defaults apply.
  }
  rpmOverrideCache = { value, expiresAt: now + RPM_CACHE_TTL_MS };
  return value;
}

async function resolveRpm(provider: string): Promise<number> {
  const base = PROVIDER_RPM[provider] ?? 60;
  if (base === UNLIMITED) return UNLIMITED; // local/CLI providers never override
  const override = (await getRpmOverrides())[provider];
  if (override != null && Number.isFinite(override) && override > 0) return override;
  return base;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until a provider call slot is available. Unknown providers
 * default to a 60 RPM ceiling; this errs on the side of caution and
 * can be tuned by adding the provider name to PROVIDER_RPM.
 */
export async function acquireProviderToken(provider: string): Promise<void> {
  const rpm = await resolveRpm(provider);
  if (rpm === UNLIMITED) return;

  while (true) {
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const existing = timestampsByProvider.get(provider) ?? [];
    const fresh = existing.filter((t) => t > windowStart);

    if (fresh.length < rpm) {
      fresh.push(now);
      timestampsByProvider.set(provider, fresh);
      return;
    }

    // Wait just past the oldest fresh timestamp's expiration, then loop
    // and try again. The +50ms cushion avoids spin races at the exact
    // window boundary.
    const oldest = fresh[0]!;
    const waitMs = Math.max(1, oldest + WINDOW_MS - now + 50);
    timestampsByProvider.set(provider, fresh);
    await sleep(waitMs);
  }
}

/**
 * Test-only. Clears all recorded timestamps so each test starts with a
 * full quota.
 */
export function _resetRateLimitForTests(): void {
  timestampsByProvider.clear();
  rpmOverrideCache = null;
}
