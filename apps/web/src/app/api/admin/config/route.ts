import { cookies } from 'next/headers';
import { readAccessJson } from 'thesidedoor-core/access/http';
import { providerDescriptors } from 'thesidedoor-core/ai/catalog';
import type { Prisma } from '@/generated/prisma/client';
import { SHARED_SESSION_COOKIE } from '@/lib/sidedoor/service';
import { readProviderConfiguration, saveProviderConfiguration, configurationRequestOwner, providerConfigurationError, parseCredentialPatch, type ProviderCredentialDescription } from '@/lib/sidedoor/provider-config';
import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { LOCAL_PROVIDERS, isLocalProviderReachable } from '@/lib/scraper/ai-registry';
import { registerForCommunity } from '@/lib/community-sync';
import { encryptSecret } from '@/lib/secret-crypto';
import { isThemeId } from '@/lib/theme';
import { updateCronInterval } from '@/lib/cron';
import { requireAdminApi } from '@/lib/admin-guard';
import { isAggregatorSource } from '@/lib/scraper/navigate';
import { validateInferenceSelection } from '@/lib/scraper/inference-selection';
import { accessRouteResponse } from '@/lib/sidedoor/access-http';

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

function stripHashes(config: Record<string, unknown>, credentials: ProviderCredentialDescription[]) {
  const rest = { ...config };
  delete rest.vpnActivationCode;
  const hasStoredKey = (provider: string) => credentials.find(item => item.provider === provider)?.fields.some(field => ['apiKey', 'compatibleApiKey'].includes(field.id) && field.source === 'stored' && field.configured) ?? false;
  return {
    ...rest,
    communityApiKey: typeof config.communityApiKey === 'string' ? maskSecret(config.communityApiKey) : null,
    hasVpnActivationCode: Boolean(config.vpnActivationCode),
    hasAnthropicKey: hasStoredKey('anthropic'), hasOpenaiKey: hasStoredKey('openai'), hasGoogleKey: hasStoredKey('google'),
    providerCredentials: credentials, providerDescriptors: providerDescriptors(),
    isSelfHosted: process.env.SELF_HOSTED === 'true',
  };
}

export async function GET() {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return apiError('Unauthorized', 401);
  try {
    const { config, credentials } = await readProviderConfiguration(token);
    return apiSuccess(stripHashes(config as unknown as Record<string, unknown>, credentials));
  } catch (error) { return providerConfigurationError(error); }
}

export async function PATCH(request: NextRequest) {
  try {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const payload = await readAccessJson(request).catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return apiError('Invalid JSON body', 400);
  const body = payload as Record<string, unknown>;
  if ('adminPassword' in body) {
    if (Object.keys(body).some(key => key !== 'adminPassword' && key !== 'currentPassword'))
      return apiError('Save account credentials separately from instance settings', 400);
    return accessRouteResponse(request, 'change-password', { password: body.adminPassword, ...(body.currentPassword === undefined ? {} : { currentPassword: body.currentPassword }) });
  }

  const owner = await configurationRequestOwner(request);
  if (owner.response) return owner.response;
  const credentialFields = parseCredentialPatch(body.credentials) ?? {};
  if (Object.hasOwn(credentialFields, 'baseUrl')) {
    if (body.customBaseUrl !== undefined && body.customBaseUrl !== credentialFields.baseUrl) return apiError('Conflicting provider endpoints', 400);
    body.customBaseUrl = credentialFields.baseUrl;
  }
  const { provider, model } = body;
  if ((provider !== undefined && typeof provider !== 'string') || (model !== undefined && typeof model !== 'string')) return apiError('Provider and model must be strings', 400);

  const data: Record<string, unknown> = {};
  if (provider) data.provider = provider;
  if (model) data.model = model;

  // Read the current config once; reused by the key guard and the reachability
  // probe below so the request makes a single DB read.
  const existingConfig = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const selectionChanged = (provider !== undefined && provider !== existingConfig?.provider)
    || (model !== undefined && model !== existingConfig?.model)
    || (body.reasoningEffort !== undefined && body.reasoningEffort !== (existingConfig?.reasoningEffort ?? null));
  if (selectionChanged) {
    const reasoning = body.reasoningEffort !== undefined ? body.reasoningEffort
      : provider !== undefined && provider !== existingConfig?.provider ? null : existingConfig?.reasoningEffort ?? null;
    try {
      const selection = await validateInferenceSelection(provider ?? existingConfig?.provider ?? 'anthropic', model ?? existingConfig?.model ?? 'claude-haiku-4-5-20251001', reasoning);
      Object.assign(data, selection);
    } catch (error) { return apiError(error instanceof Error ? error.message : 'Invalid inference selection', 400); }
  }

  const selectedProvider = provider ?? existingConfig?.provider ?? 'anthropic';
  const descriptor = providerDescriptors().find(item => item.id === selectedProvider);
  if (!descriptor) return apiError('Unknown provider', 400);
  if (body.apiKey !== undefined) {
    if (body.apiKey !== null && typeof body.apiKey !== 'string') return apiError('API key must be a string or null', 400);
    const endpoint = body.customBaseUrl !== undefined ? body.customBaseUrl : existingConfig?.customBaseUrl;
    const field = endpoint && descriptor.fields.some(item => item.id === 'compatibleApiKey') ? 'compatibleApiKey' : 'apiKey';
    credentialFields[field] = body.apiKey || null;
  }
  if (body.customBaseUrl !== undefined && body.customBaseUrl !== null && typeof body.customBaseUrl !== 'string') return apiError('Invalid provider endpoint', 400);
  if (body.customBaseUrl !== undefined && descriptor.fields.some(field => field.id === 'baseUrl')) credentialFields.baseUrl = body.customBaseUrl || null;
  for (const [id, value] of Object.entries(credentialFields)) {
    const field = descriptor.fields.find(item => item.id === id);
    if (!field || (value !== null && typeof value !== field.kind)) return apiError('Invalid provider configuration field', 400);
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
    if (body.vpnProvider !== null && (typeof body.vpnProvider !== 'string' || !validProviders.includes(body.vpnProvider))) {
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

  const expectedUpdatedAt = body.expectedUpdatedAt === undefined ? existingConfig?.updatedAt ?? null : typeof body.expectedUpdatedAt === 'string' ? new Date(body.expectedUpdatedAt) : null;
  if (body.resetCredentials !== undefined && typeof body.resetCredentials !== 'boolean') return apiError('Invalid credential reset', 400);
  if ((body.credentials !== undefined || body.resetCredentials !== undefined) && body.expectedRevision === undefined) return apiError('Configuration revision is required. Reload before saving.', 400);
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) return apiError('Invalid configuration revision', 400);
  if (body.expectedUpdatedAt !== undefined && (!expectedUpdatedAt || !Number.isFinite(expectedUpdatedAt.getTime()))) return apiError('Invalid configuration revision', 400);
  const { config, credentials } = await saveProviderConfiguration(owner.token!, {
    resetCredentials: body.resetCredentials === true,
    expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : existingConfig?.providerRevision ?? 0,
    data: data as Prisma.ExtractionConfigUncheckedCreateInput,
    fields: Object.keys(credentialFields).length ? credentialFields : undefined,
    expectedUpdatedAt,
  });

  // Immediately reschedule cron if the scrape interval changed
  if (typeof data.scrapeInterval === 'number') {
    updateCronInterval(data.scrapeInterval);
  }

  return apiSuccess(stripHashes(config as unknown as Record<string, unknown>, credentials));
  } catch (error) { return providerConfigurationError(error); }
}
