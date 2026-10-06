import { createHmac } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { deriveSecretEncryptionKey } from '@/lib/secret-crypto';
import { providerVault } from '../sidedoor/providers/provider-credentials';
import { CLI_PROVIDERS, EXTRACTION_PROVIDERS } from '../scraper/ai-registry';
import type { ParseConfiguration } from '../scraper/parse-query';
import type { ReasoningSelection } from '../scraper/cli-model-types';

export function parseDigest(value: unknown): string {
  return createHmac('sha256', deriveSecretEncryptionKey()).update(JSON.stringify(value)).digest('hex');
}

/** Resolve settings and provider authority in the caller's coherent transaction. */
export async function captureParseConfiguration(database: Prisma.TransactionClient) {
  const saved = await database.extractionConfig.findUnique({ where: { id: 'singleton' } });
  const provider = saved?.provider ?? 'anthropic';
  if (!EXTRACTION_PROVIDERS[provider]) throw new Error('Unknown extraction provider');
  const { vault, store } = providerVault(database);
  const state = await store.read();
  const authority = state.providers.find(entry => entry.provider === provider) ?? null;
  const credentials = CLI_PROVIDERS[provider] ? undefined : vault.resolveState(state, provider);
  const configuration: ParseConfiguration = {
    provider, model: saved?.model ?? 'claude-haiku-4-5-20251001',
    customBaseUrl: saved?.customBaseUrl ?? null,
    reasoningEffort: saved?.reasoningEffort as ReasoningSelection ?? null,
    extractTimeoutSeconds: saved?.extractTimeoutSeconds ?? 90,
    credentials,
  };
  const orderedCredentials = Object.fromEntries(Object.entries(credentials ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return { configuration, fingerprint: parseDigest({ ...configuration, credentials: orderedCredentials, authority }) };
}
