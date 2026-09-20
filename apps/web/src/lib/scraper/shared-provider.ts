import type { CredentialValues } from 'thesidedoor-core/ai';
import type { ProviderReadiness } from 'thesidedoor-core/ai';
import { IncompleteGenerationError } from 'thesidedoor-core/ai/usage';
import { EXTRACT_TIMEOUT_MS, type ExtractOptions, type ExtractionResult } from './ai-registry';

export async function sharedProviderReadiness(
  provider: string,
  credentials: CredentialValues,
  signal?: AbortSignal,
): Promise<ProviderReadiness> {
  const [{ ProviderRegistry }, { apiProviders }] = await Promise.all([
    import('thesidedoor-core/ai'),
    import('thesidedoor-core/ai/providers'),
  ]);
  const registry = new ProviderRegistry({
    providers: apiProviders({ streaming: false, maxTokensParameter: 'max_tokens' }),
    credentials: { async resolve() { return { ...credentials }; } },
  });
  return registry.readiness(provider, signal ?? AbortSignal.timeout(5_000));
}

/** Application policy stays here; provider construction and execution live in Sidedoor. */
export async function extractWithSharedProvider(
  provider: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: ExtractOptions,
): Promise<ExtractionResult> {
  const [{ ProviderRegistry }, { apiProviders }] = await Promise.all([
    import('thesidedoor-core/ai'),
    import('thesidedoor-core/ai/providers'),
  ]);
  const baseUrl = provider === 'google' ? undefined : options?.baseUrl;
  const values: CredentialValues = options?.credentials ? { ...options.credentials } : { apiKey };
  if (baseUrl && !options?.credentials) {
    values.baseUrl = baseUrl;
    values.compatibleApiKey = apiKey;
    values.allowAnonymous = !apiKey;
  }
  const registry = new ProviderRegistry({
    providers: apiProviders({ streaming: false, maxTokensParameter: 'max_tokens' }),
    credentials: { async resolve() { return values; } },
  });
  const result: ExtractionResult = { content: '', usage: { inputTokens: null, outputTokens: null } };
  for await (const event of registry.generate({
    provider,
    model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
      { role: 'user', content: [{ type: 'text', text: userPrompt }] },
    ],
    responseFormat: provider === 'google' || provider === 'anthropic' ? undefined : options?.responseFormat,
    maxOutputTokens: provider === 'google' ? undefined : 8192,
    timeoutMs: options?.timeoutMs ?? EXTRACT_TIMEOUT_MS,
    signal: options?.signal,
  })) {
    if (event.type === 'text') result.content += event.text;
    if (event.type === 'usage') result.usage = { ...event.usage };
    if (event.type === 'finish' && event.reason !== 'complete')
      throw new IncompleteGenerationError(event.reason, event.usage);
    if (event.type === 'finish' && event.usage) {
      result.usage = { ...event.usage };
    }
  }
  return result;
}
