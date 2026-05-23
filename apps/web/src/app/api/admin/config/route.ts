import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { EXTRACTION_PROVIDERS } from '@/lib/scraper/ai-registry';
import { hashPassword } from '@/lib/password';
import { registerForCommunity } from '@/lib/community-sync';
import { encryptVpnCode } from '@/lib/vpn-crypto';
import { isThemeId } from '@/lib/theme';
import { updateCronInterval } from '@/lib/cron';
import { requireAdminApi } from '@/lib/admin-guard';

function stripHashes(config: Record<string, unknown>) {
  const { adminPasswordHash, vpnActivationCode, ...rest } = config;
  return {
    ...rest,
    hasAdminPassword: !!adminPasswordHash,
    hasVpnActivationCode: !!vpnActivationCode,
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
  if (body.defaultSearchMethod !== undefined) {
    if (body.defaultSearchMethod !== 'ai' && body.defaultSearchMethod !== 'manual') {
      return apiError('defaultSearchMethod must be "ai" or "manual"', 400);
    }
    data.defaultSearchMethod = body.defaultSearchMethod;
  }
  if (typeof body.adminPassword === 'string' && body.adminPassword.length > 0) {
    data.adminPasswordHash = await hashPassword(body.adminPassword);
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
    data.vpnActivationCode = encryptVpnCode(body.vpnActivationCode);
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
    }
    data.customBaseUrl = body.customBaseUrl || null;
  }

  const config = await prisma.extractionConfig.upsert({
    where: { id: 'singleton' },
    update: data,
    create: { id: 'singleton', ...data },
  });

  // Immediately reschedule cron if the scrape interval changed
  if (typeof data.scrapeInterval === 'number') {
    updateCronInfterval(data.scrapeInterval);
  }

  if (typeof data.extractTimeoutSeconds === 'number') {

  }

  return apiSuccess(stripHashes(config as unknown as Record<string, unknown>));
}
