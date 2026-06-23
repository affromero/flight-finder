import { prisma } from '@/lib/prisma';
import { apiSuccess, apiError } from '@/lib/api-response';
import { hashPassword } from '@/lib/password';
import { registerForCommunity } from '@/lib/community-sync';
import { encryptSecret } from '@/lib/secret-crypto';

// Env-backed provider -> the ExtractionConfig column that stores its key,
// encrypted at rest (#149). Keep in sync with STORED_KEY_FIELD in ai-registry.
const PROVIDER_KEY_COLUMN: Record<string, 'anthropicApiKey' | 'openaiApiKey' | 'googleApiKey'> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
  google: 'googleApiKey',
};

export async function POST(request: Request) {
  // Only allow setup if no config exists yet
  const existing = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

  if (existing?.adminPasswordHash) {
    return apiError('Setup already completed. Use admin panel to change settings.', 403);
  }

  const body = await request.json();
  const { adminPassword, provider, model, communitySharing, customBaseUrl, publicBaseUrl, apiKey } = body as {
    adminPassword: string;
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

  const isSelfHosted = process.env.SELF_HOSTED === 'true';

  if (!isSelfHosted && (!adminPassword || adminPassword.length < 8)) {
    return apiError('Password must be at least 8 characters', 400);
  }

  if (!provider || !model) {
    return apiError('Provider and model are required', 400);
  }

  const passwordHash = isSelfHosted
    ? 'self-hosted'
    : await hashPassword(adminPassword);

  // Store the entered provider key encrypted at rest (#149), so a self-hosted
  // user can configure a keyed provider in the wizard without editing .env.
  const providerKeyData: Record<string, string> = {};
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const column = PROVIDER_KEY_COLUMN[provider];
    if (column) providerKeyData[column] = encryptSecret(apiKey);
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

  await prisma.extractionConfig.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      provider,
      model,
      adminPasswordHash: passwordHash,
      communitySharing: communitySharing && communityApiKey !== null,
      communityApiKey,
      customBaseUrl: customBaseUrl || null,
      publicBaseUrl: normalizedPublicBaseUrl,
      ...providerKeyData,
    },
    update: {
      provider,
      model,
      adminPasswordHash: passwordHash,
      communitySharing: communitySharing && communityApiKey !== null,
      communityApiKey,
      customBaseUrl: customBaseUrl || null,
      publicBaseUrl: normalizedPublicBaseUrl,
      ...providerKeyData,
    },
  });

  return apiSuccess({ message: 'Setup complete' });
}
