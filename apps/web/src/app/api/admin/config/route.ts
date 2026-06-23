import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { EXTRACTION_PROVIDERS, LOCAL_PROVIDERS, isLocalProviderReachable } from '@/lib/scraper/ai-registry';
import { hashPassword } from '@/lib/password';
import { registerForCommunity } from '@/lib/community-sync';
import { encryptSecret, decryptSecret } from '@/lib/secret-crypto';
import { isThemeId } from '@/lib/theme';
import { updateCronInterval } from '@/lib/cron';
import { requireAdminApi } from '@/lib/admin-guard';
import { isAggregatorSource } from '@/lib/scraper/navigate';

/**
 * Masks the middle of a secret so the full value never crosses the wire.
 * Keeps the first 8 and last 4 characters (the fingerprint the admin UI
 * renders) and replaces the interior with a fixed mask. Short keys are masked
 * whole.
 */
function maskSecret(value: string): string {
  if (value.length <= 12) return '************';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function stripHashes(config: Record<string, unknown>) {
  const {
    adminPasswordHash, vpnActivationCode, communityApiKey,
    anthropicApiKey, openaiApiKey, googleApiKey,
    ...rest
  } = config;
  return {
    ...rest,
    // Never return the community API key in plaintext. The GET response is
    // redacted to a masked fingerprint; the key stays writable via PATCH.
    communityApiKey: typeof communityApiKey === 'string' ? maskSecret(communityApiKey) : null,
    hasAdminPassword: !!adminPasswordHash,
    hasVpnActivationCode: !!vpnActivationCode,
    // Provider API keys (#149): never cross the wire, even masked. The UI only
    // needs to know whether one is stored so it can show a "saved" state.
    hasAnthropicKey: !!anthropicApiKey,
    hasOpenaiKey: !!openaiApiKey,
    hasGoogleKey: !!googleApiKey,
    isSelfHosted: process.env.SELF_HOSTED === 'true',
  };
}

export async function GET() {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const config = await prisma.extractionConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

  return apiSuccess(stripHashes(config as unknown as Record<string, unknown>));
}

export async function PATCH(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const { provider, model } = body;

  if (provider) {
    const providerConfig = EXTRACTION_PROVIDERS[provider];
    if (!providerConfig) {
      return apiError(`Unknown provider: ${provider}`, 400);
    }

    if (model && !providerConfig.allowCustomModel) {
      const validModel = providerConfig.models.find((m) => m.id === model);
      if (!validModel) {
        return apiError(`Invalid model "${model}" for provider "${provider}"`, 400);
      }
    }
  }

  const data: Record<string, unknown> = {};
  if (provider) data.provider = provider;
  if (model) data.model = model;

  // Read the current config once; reused by the key guard and the reachability
  // probe below so the request makes a single DB read.
  const existingConfig = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });

  // Provider API key (#149): admins enter the key in the GUI instead of editing
  // .env. Store it encrypted in the per-provider column (a non-empty string
  // sets it, null/'' clears it, absent leaves it unchanged), keyed to the
  // provider in this same request. Only env-backed providers have a column;
  // CLI/local providers need no key. Then reject selecting an env-backed
  // provider with no usable key (stored, env, or an openai local endpoint) so
  // the save fails loudly here instead of silently at the next scrape.
  if (provider) {
    const KEY_COLUMN: Record<string, 'anthropicApiKey' | 'openaiApiKey' | 'googleApiKey'> = {
      anthropic: 'anthropicApiKey',
      openai: 'openaiApiKey',
      google: 'googleApiKey',
    };
    const envKey = EXTRACTION_PROVIDERS[provider]?.envKey;
    const column = KEY_COLUMN[provider];
    if (envKey) {
      const incomingKey = typeof body.apiKey === 'string' && body.apiKey.length > 0;
      const clearing = body.apiKey === '' || body.apiKey === null;
      if (column && typeof body.apiKey === 'string') {
        data[column] = incomingKey ? encryptSecret(body.apiKey) : null;
      } else if (column && body.apiKey === null) {
        data[column] = null;
      }
      // A stored key only counts if it actually decrypts: runtime resolution
      // (resolveApiKey) falls through to env on a decrypt failure, so the guard
      // must too, otherwise an undecryptable key (eg. after ADMIN_SESSION_SECRET
      // rotation) would pass here and then fail at scrape time. Codex audit #2.
      const storedEnc = !clearing && column ? existingConfig?.[column] : null;
      const storedKey = !!(storedEnc && decryptSecret(storedEnc));
      const envPresent = !!process.env[envKey];
      const baseUrl =
        (typeof body.customBaseUrl === 'string' && body.customBaseUrl) ||
        existingConfig?.customBaseUrl ||
        process.env.OPENAI_BASE_URL;
      const openaiLocal = provider === 'openai' && !!baseUrl;
      if (!incomingKey && !storedKey && !envPresent && !openaiLocal) {
        return apiError(
          `Provider "${provider}" needs an API key. Enter one here or set the ${envKey} environment variable.`,
          400,
        );
      }
    }
  }

  if (body.theme !== undefined) {
    if (typeof body.theme !== 'string' || !isThemeId(body.theme)) {
      return apiError('theme must be a valid theme id', 400);
    }
    data.theme = body.theme;
  }
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
  if (typeof body.scrapeIntervalHours === 'number') {
    data.scrapeInterval = Math.max(1, Math.min(24, Math.round(body.scrapeIntervalHours)));
  }
  // `typeof NaN === 'number'` is true, so check `Number.isFinite` to reject
  // cleared inputs (NaN) before they hit Prisma and crash with a runtime error.
  if (typeof body.extractTimeoutSeconds === 'number' && Number.isFinite(body.extractTimeoutSeconds)) {
    data.extractTimeoutSeconds = Math.max(30, Math.min(600, Math.round(body.extractTimeoutSeconds)));
  }
  if (typeof body.maxFlightsPerDate === 'number' && Number.isFinite(body.maxFlightsPerDate)) {
    data.maxFlightsPerDate = Math.max(5, Math.min(50, Math.round(body.maxFlightsPerDate)));
  }
  if (typeof body.maxTrackedPerRoute === 'number' && Number.isFinite(body.maxTrackedPerRoute)) {
    data.maxTrackedPerRoute = Math.max(1, Math.min(50, Math.round(body.maxTrackedPerRoute)));
  }
  if (typeof body.previewMaxCombos === 'number' && Number.isFinite(body.previewMaxCombos)) {
    data.previewMaxCombos = Math.max(6, Math.min(96, Math.round(body.previewMaxCombos)));
  }
  if (typeof body.notifyMinDropAbs === 'number' && Number.isFinite(body.notifyMinDropAbs)) {
    data.notifyMinDropAbs = Math.max(0, Math.min(100000, body.notifyMinDropAbs));
  }
  if (typeof body.notifyMinDropPct === 'number' && Number.isFinite(body.notifyMinDropPct)) {
    data.notifyMinDropPct = Math.max(0, Math.min(1, body.notifyMinDropPct));
  }
  // Provider RPM overrides. null clears the override (revert to env/default).
  for (const key of ['anthropicRpm', 'googleRpm', 'openaiRpm', 'groqRpm']) {
    if (body[key] === null) {
      data[key] = null;
    } else if (typeof body[key] === 'number' && Number.isFinite(body[key])) {
      data[key] = Math.max(1, Math.min(10000, Math.round(body[key])));
    }
  }
  if (body.previewConcurrency === null) {
    data.previewConcurrency = null;
  } else if (typeof body.previewConcurrency === 'number' && Number.isFinite(body.previewConcurrency)) {
    // Match the env-path ceiling (parsePreviewConcurrency caps at 10) so the two
    // sources never disagree on the max parallel browsers.
    data.previewConcurrency = Math.max(1, Math.min(10, Math.round(body.previewConcurrency)));
  }
  if (body.previewAdmissionCap === null) {
    data.previewAdmissionCap = null;
  } else if (typeof body.previewAdmissionCap === 'number' && Number.isFinite(body.previewAdmissionCap)) {
    data.previewAdmissionCap = Math.max(1, Math.min(50, Math.round(body.previewAdmissionCap)));
  }
  if (body.defaultSearchMethod !== undefined) {
    if (body.defaultSearchMethod !== 'ai' && body.defaultSearchMethod !== 'manual') {
      return apiError('defaultSearchMethod must be "ai" or "manual"', 400);
    }
    data.defaultSearchMethod = body.defaultSearchMethod;
  }
  if (typeof body.adminPassword === 'string' && body.adminPassword.length > 0) {
    if (body.adminPassword.length < 8) {
      return apiError('adminPassword must be at least 8 characters', 400);
    }
    data.adminPasswordHash = await hashPassword(body.adminPassword);
    // Revoke every existing admin session: any token issued before now is
    // rejected by the Node guard's adminSessionsValidFrom check.
    data.adminSessionsValidFrom = new Date();
  }
  if (typeof body.communityRegistrationOpen === 'boolean') {
    data.communityRegistrationOpen = body.communityRegistrationOpen;
  }
  if (typeof body.communitySharing === 'boolean') {
    data.communitySharing = body.communitySharing;
    // Register for community API key if enabling and no key exists
    if (body.communitySharing) {
      const existing = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
      if (!existing?.communityApiKey) {
        try {
          data.communityApiKey = await registerForCommunity();
        } catch {
          return apiError('Failed to register with community hub', 502);
        }
      }
    }
  }

  if (body.defaultCurrency !== undefined) {
    if (body.defaultCurrency !== null && (typeof body.defaultCurrency !== 'string' || !/^[A-Z]{3}$/.test(body.defaultCurrency))) {
      return apiError('defaultCurrency must be a 3-letter ISO 4217 code or null', 400);
    }
    data.defaultCurrency = body.defaultCurrency;
  }
  if (body.defaultCountry !== undefined) {
    if (body.defaultCountry !== null && (typeof body.defaultCountry !== 'string' || !/^[A-Z]{2}$/.test(body.defaultCountry))) {
      return apiError('defaultCountry must be a 2-letter ISO 3166-1 code or null', 400);
    }
    data.defaultCountry = body.defaultCountry;
  }
  if (body.vpnProvider !== undefined) {
    const validProviders = ['none', 'expressvpn'];
    if (body.vpnProvider !== null && !validProviders.includes(body.vpnProvider)) {
      return apiError(`vpnProvider must be one of: ${validProviders.join(', ')}`, 400);
    }
    data.vpnProvider = body.vpnProvider;
  }
  if (body.vpnCountries !== undefined) {
    if (!Array.isArray(body.vpnCountries)) {
      return apiError('vpnCountries must be an array of 2-letter country codes', 400);
    }
    for (const code of body.vpnCountries) {
      if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) {
        return apiError(`Invalid country code in vpnCountries: ${code}`, 400);
      }
    }
    data.vpnCountries = body.vpnCountries;
  }
  if (typeof body.vpnActivationCode === 'string' && body.vpnActivationCode.length > 0) {
    data.vpnActivationCode = encryptSecret(body.vpnActivationCode);
  } else if (body.vpnActivationCode === null) {
    data.vpnActivationCode = null;
  }

  if (body.customBaseUrl !== undefined) {
    if (body.customBaseUrl !== null && typeof body.customBaseUrl !== 'string') {
      return apiError('customBaseUrl must be a URL string or null', 400);
    }
    if (body.customBaseUrl && typeof body.customBaseUrl === 'string') {
      try { new URL(body.customBaseUrl); } catch {
        return apiError('customBaseUrl must be a valid URL', 400);
      }
      // For a local provider, probe the endpoint so an unreachable URL fails at
      // save time instead of silently dying at the next scrape (#153). Only when
      // the URL actually CHANGED (not re-sent unchanged on an unrelated save) and
      // the selected provider is local — this avoids a 5s stall (and a spurious
      // 422 if the service is briefly down) on every save, and limits the
      // server-side fetch to a deliberate URL change (Codex audit #4).
      const targetProvider = provider || existingConfig?.provider;
      const urlChanged = body.customBaseUrl !== existingConfig?.customBaseUrl;
      if (urlChanged && targetProvider && LOCAL_PROVIDERS.has(targetProvider)) {
        const reachable = await isLocalProviderReachable(targetProvider, body.customBaseUrl);
        if (!reachable) {
          return apiError(
            `Could not reach ${targetProvider} at ${body.customBaseUrl}. Check the URL and that the service is running.`,
            422,
          );
        }
      }
    }
    data.customBaseUrl = body.customBaseUrl || null;
  }

  if (body.publicBaseUrl !== undefined) {
    if (body.publicBaseUrl !== null && typeof body.publicBaseUrl !== 'string') {
      return apiError('publicBaseUrl must be a URL string or null', 400);
    }
    if (body.publicBaseUrl && typeof body.publicBaseUrl === 'string') {
      try { new URL(body.publicBaseUrl); } catch {
        return apiError('publicBaseUrl must be a valid URL', 400);
      }
    }
    data.publicBaseUrl = body.publicBaseUrl || null;
  }

  if (body.aggregatorsEnabled !== undefined) {
    if (!Array.isArray(body.aggregatorsEnabled)) {
      return apiError('aggregatorsEnabled must be an array of strings', 422);
    }
    for (const a of body.aggregatorsEnabled) {
      if (!isAggregatorSource(a)) {
        return apiError(`aggregatorsEnabled contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    data.aggregatorsEnabled = body.aggregatorsEnabled;
  }

  const config = await prisma.extractionConfig.upsert({
    where: { id: 'singleton' },
    update: data,
    create: { id: 'singleton', ...data },
  });

  // Immediately reschedule cron if the scrape interval changed
  if (typeof data.scrapeInterval === 'number') {
    updateCronInterval(data.scrapeInterval);
  }

  return apiSuccess(stripHashes(config as unknown as Record<string, unknown>));
}
