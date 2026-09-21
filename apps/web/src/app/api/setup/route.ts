import { prisma } from '@/lib/prisma';
import { apiSuccess, apiError } from '@/lib/api-response';
import { registerForCommunity } from '@/lib/community-sync';
import { readAccessJson } from 'thesidedoor-core/access/http';
import { providerDescriptors } from 'thesidedoor-core/ai/catalog';
import { configurationRequestOwner, saveProviderConfiguration, parseCredentialPatch, providerConfigurationError } from '@/lib/sidedoor/providers/provider-config';
import { validateInferenceSelection } from '@/lib/scraper/inference-selection';
import { requireAdminApi } from '@/lib/admin-guard';

export async function POST(request: Request) {
  try {
  const denied = await requireAdminApi();
  if (denied) return denied;
  const owner = await configurationRequestOwner(request);
  if (owner.response) return owner.response;
  // Only allow setup if no config exists yet
  const existing = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

  if (existing?.setupComplete) {
    return apiError('Setup already completed. Use admin panel to change settings.', 403);
  }

  const payload = await readAccessJson(request).catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return apiError('Invalid JSON body', 400);
  const body = payload as Record<string, unknown>;
  const { provider, model, communitySharing, customBaseUrl, publicBaseUrl, apiKey } = body as {
    provider: string;
    model: string;
    communitySharing?: boolean;
    customBaseUrl?: string | null;
    publicBaseUrl?: string | null;
    apiKey?: string | null;
  };

  // Optional public URL the user plans to reach the instance at (for /connect's
  // QR and notification deep links). Validate it's a real http(s) URL or null.
  let normalizedPublicBaseUrl: string | null = null;
  if (publicBaseUrl !== undefined && publicBaseUrl !== null && typeof publicBaseUrl !== 'string') return apiError('Invalid public URL', 400);
  if (communitySharing !== undefined && typeof communitySharing !== 'boolean') return apiError('Invalid community sharing choice', 400);
  if (typeof publicBaseUrl === 'string' && publicBaseUrl.trim()) {
    try {
      const u = new URL(publicBaseUrl.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return apiError('publicBaseUrl must be an http(s) URL', 400);
      }
      normalizedPublicBaseUrl = u.toString().replace(/\/+$/, '');
    } catch {
      return apiError('publicBaseUrl must be a valid URL', 400);
    }
  }

  if ('adminPassword' in body) return apiError('Manage the claimed owner password at /access/security', 400);

  if (!provider || !model) {
    return apiError('Provider and model are required', 400);
  }
  let selection;
  try { selection = await validateInferenceSelection(provider, model, body.reasoningEffort); }
  catch (error) { return apiError(error instanceof Error ? error.message : 'Invalid inference selection', 400); }

  const fields = parseCredentialPatch(body.credentials) ?? {};
  if (body.resetCredentials !== undefined && typeof body.resetCredentials !== 'boolean') return apiError('Invalid credential reset', 400);
  const descriptor = providerDescriptors().find(item => item.id === provider);
  if (!descriptor) return apiError('Unknown provider', 400);
  if (apiKey !== undefined) {
    if (apiKey !== null && typeof apiKey !== 'string') return apiError('Invalid API key', 400);
    const target = customBaseUrl && descriptor.fields.some(field => field.id === 'compatibleApiKey') ? 'compatibleApiKey' : 'apiKey';
    fields[target] = apiKey || null;
  }
  if (customBaseUrl !== undefined && descriptor.fields.some(field => field.id === 'baseUrl')) fields.baseUrl = customBaseUrl || null;
  for (const [id, value] of Object.entries(fields)) {
    const field = descriptor.fields.find(item => item.id === id);
    if (!field || (value !== null && typeof value !== field.kind)) return apiError('Invalid provider configuration field', 400);
  }

  // Register for community API key if opted in
  let communityApiKey: string | null = null;
  if (communitySharing) {
    try {
      communityApiKey = await registerForCommunity();
    } catch (err) {
      console.error('[setup] Community registration failed:', err instanceof Error ? err.message : err);
      // Non-fatal — setup continues without community sharing
    }
  }

  await saveProviderConfiguration(owner.token!, {
    resetCredentials: body.resetCredentials === true,
    expectedRevision: existing?.providerRevision ?? 0,
    expectedUpdatedAt: existing?.updatedAt ?? null,
    setup: true,
    admissionLock: true,
    fields,
    data: {
      provider, model, reasoningEffort: selection.reasoningEffort,
      setupComplete: true,
      communitySharing: Boolean(communitySharing && communityApiKey !== null),
      communityApiKey, publicBaseUrl: normalizedPublicBaseUrl,
    },
  });

  return apiSuccess({ message: 'Setup complete' });
  } catch (error) { return providerConfigurationError(error); }
}
