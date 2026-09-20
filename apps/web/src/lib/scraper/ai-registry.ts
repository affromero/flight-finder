import { extractWithSharedProvider } from './shared-provider';
import { sharedProviderReadiness } from './shared-provider';
import { extractCodex } from './codex-extraction';
import { extractClaude } from './claude-extraction';

import {
  PROVIDER_METADATA,
  CLI_PROVIDERS,
  LOCAL_PROVIDERS,
  type ModelInfo,
  type ProviderMeta,
} from './provider-metadata';
import { prisma } from '@/lib/prisma';
import { resolveProviderCredentials } from '@/lib/sidedoor/provider-credentials';
import { apiProviders, providerConnection } from 'thesidedoor-core/ai/providers';
import { CredentialDecryptionError } from 'thesidedoor-core/configuration';
import type { CredentialValues, TokenUsage } from 'thesidedoor-core/ai';
import { estimateTokenCost } from 'thesidedoor-core/observability/pricing';
export { resolveProviderCredentials };
import { CliModelError, probeCli } from './cli-models';
import type { ReasoningSelection } from './cli-model-types';

// Client-safe metadata lives in provider-metadata.ts so the settings/setup/admin
// client pages can render the provider UI without pulling this module (and the
// LLM SDKs its extractors import) into the client bundle. Re-exported here so
// existing server-side imports of these symbols keep resolving from ai-registry.
export { CLI_PROVIDERS, LOCAL_PROVIDERS };
export type { ModelInfo, ProviderMeta };

/**
 * Per-LLM-call timeout in ms. Without this, Gemini's SDK has no default
 * request timeout and a hung call sits forever, which is what was happening
 * in issue #65 (cron runs showed "[extract] sending ..." with no follow-up
 * log line). 90s is conservative: Gemini Flash p99 for ~3k chars is ~30s.
 * Configurable via env var EXTRACT_TIMEOUT_MS for ops tuning.
 */
const PARSED_TIMEOUT = parseInt(process.env.EXTRACT_TIMEOUT_MS ?? '90000', 10);
export const EXTRACT_TIMEOUT_MS =
  Number.isFinite(PARSED_TIMEOUT) && PARSED_TIMEOUT > 0 ? PARSED_TIMEOUT : 90_000;

/** Resolve the credential for the selected endpoint from one shared configuration snapshot. */
export async function resolveApiKey(provider: string, snapshot?: CredentialValues): Promise<string> {
  if (CLI_PROVIDERS[provider]) return '';
  const values = snapshot ?? await resolveProviderCredentials(provider);
  const metadata = PROVIDER_METADATA[provider];
  if (!metadata) throw new Error('Unknown provider');
  if (metadata.defaultBaseUrl) return providerConnection(values, {
    defaultBaseUrl: metadata.defaultBaseUrl,
    normalizeV1: LOCAL_PROVIDERS.has(provider),
    requiresKey: false,
  }).apiKey;
  return typeof values.apiKey === 'string' ? values.apiKey : '';
}

export type ExtractionUsage = TokenUsage;

export interface ExtractionResult {
  content: string;
  usage: ExtractionUsage;
}

export interface ExtractOptions {
  credentials?: CredentialValues;
  reasoningEffort?: ReasoningSelection;
  baseUrl?: string;
  signal?: AbortSignal;
  /**
   * Force the model into a structured output mode. `'json_object'` maps to
   * OpenAI's `response_format: { type: 'json_object' }`, which Ollama (>= 0.1.34),
   * llama.cpp, vLLM, and OpenAI all honour via constrained generation. Without
   * it small models occasionally return prose or a refusal and `/api/parse`
   * fails with `Failed to parse LLM response as JSON` (issue #84).
   */
  responseFormat?: 'json_object';
  /**
   * Per-call abort timeout in ms. Sourced from `ExtractionConfig.extractTimeoutSeconds`
   * so admins can extend it from the UI when slow local models on CPU exceed
   * the 90s default (issue #86). When unset, falls back to `EXTRACT_TIMEOUT_MS`
   * (90s, env-overridable). Applies to SDK providers only; CLI providers
   * (claude-code, codex) keep their own spawn timeout.
   */
  timeoutMs?: number;
}

interface ProviderConfig extends ProviderMeta {
  extract: (
    apiKey: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    options?: ExtractOptions
  ) => Promise<ExtractionResult>;
}

/** Strip benign CLI warnings (e.g. PATH update failures) from stderr */
export function filterCliStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => !line.includes('could not update PATH'))
    .join('\n')
    .trim();
}

/**
 * Local OpenAI compat servers (Ollama, llama.cpp, vLLM) expose chat completions
 * at `/v1/chat/completions`. The OpenAI SDK just appends `/chat/completions` to
 * whatever baseURL it gets, so a URL missing `/v1` lands on Ollama's catchall
 * 404 and the SDK rewraps it as `404 404 page not found`.
 */
export function ensureV1Suffix(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export const EXTRACTION_PROVIDERS: Record<string, ProviderConfig> = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_METADATA)
      .filter(([id]) => !CLI_PROVIDERS[id])
      .map(([id, metadata]) => [id, {
        ...metadata,
        extract: (apiKey: string, model: string, systemPrompt: string, userPrompt: string, options?: ExtractOptions) =>
          extractWithSharedProvider(id, apiKey, model, systemPrompt, userPrompt, options),
      }]),
  ),
  'claude-code': {
    ...PROVIDER_METADATA['claude-code']!,
    extract: (_apiKey, model, systemPrompt, userPrompt, options) =>
      extractClaude(model, systemPrompt, userPrompt, options),
  },
  codex: {
    ...PROVIDER_METADATA.codex!,
    extract: (_apiKey, model, systemPrompt, userPrompt, options) =>
      extractCodex(model, systemPrompt, userPrompt, options),
  },
};

/**
 * Ping a local provider to check if it's actually reachable.
 * With no `overrideBaseUrl`, sources the canonical stored URL and then the
 * provider default so the status probe agrees with extraction.
 * Pass `overrideBaseUrl` to probe a specific URL instead, e.g. validating a
 * customBaseUrl at config-save time (#153); that path uses a longer timeout
 * since it is an interactive save, not a background status sweep.
 */
export type ProviderAvailability = 'configured' | 'ready' | 'no_key' | 'invalid_credentials' | 'not_installed' | 'not_authenticated' | 'unreachable';

/** Probe the exact OpenAI-compatible endpoint used by shared extraction. */
export async function isLocalProviderReachable(
  provider: string,
  overrideBaseUrl?: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  const config = EXTRACTION_PROVIDERS[provider];
  if (!config || !LOCAL_PROVIDERS.has(provider)) return false;
  const credentials = await resolveProviderCredentials(provider);
  const source = overrideBaseUrl
    || (typeof credentials.baseUrl === 'string' ? credentials.baseUrl : undefined)
    || config.defaultBaseUrl
    || '';
  if (!source) return false;
  try {
    const readiness = await sharedProviderReadiness(provider, {
      baseUrl: ensureV1Suffix(source),
      allowAnonymous: true,
    }, signal);
    return readiness.code === 'ready';
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/** API configuration checks do not claim that a remote server has authenticated the key. */
export async function detectProviderReadiness(signal?: AbortSignal): Promise<Record<string, ProviderAvailability>> {
  signal?.throwIfAborted();
  await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const statuses: Record<string, ProviderAvailability> = {};
  for (const key of Object.keys(EXTRACTION_PROVIDERS)) {
    signal?.throwIfAborted();
    if (CLI_PROVIDERS[key]) {
      try {
        statuses[key] = (await probeCli(key, signal)).authenticated ? 'ready' : 'not_authenticated';
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof CliModelError)) throw error;
        statuses[key] = 'not_installed';
      }
      continue;
    }
    if (LOCAL_PROVIDERS.has(key) && process.env.SELF_HOSTED !== 'true') {
      statuses[key] = 'not_installed';
      continue;
    }
    try {
      const values = await resolveProviderCredentials(key);
      signal?.throwIfAborted();
      const adapter = apiProviders().find(item => item.descriptor.id === key);
      if (!adapter?.validateConfiguration) throw new Error('Provider configuration validation is unavailable');
      adapter.validateConfiguration({ credentials: values, signal: signal ?? new AbortController().signal });
      if (!LOCAL_PROVIDERS.has(key)) {
        statuses[key] = 'configured';
        continue;
      }
      const readiness = await sharedProviderReadiness(key, values, signal);
      statuses[key] = readiness.code === 'ready'
        ? 'ready'
        : readiness.code === 'missing_credentials'
          ? 'no_key'
          : 'unreachable';
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CredentialDecryptionError) statuses[key] = 'invalid_credentials';
      else if (error instanceof Error && 'code' in error && error.code === 'invalid_request') statuses[key] = 'no_key';
      else throw error;
    }
  }
  return statuses;
}

export async function detectAvailableProviders(signal?: AbortSignal): Promise<string[]> {
  const readiness = await detectProviderReadiness(signal);
  return Object.keys(EXTRACTION_PROVIDERS).filter(key => readiness[key] === 'configured' || readiness[key] === 'ready');
}

export function getModelCosts(
  provider: string,
  model: string
): { costPer1kInput: number; costPer1kOutput: number } | null {
  const p = EXTRACTION_PROVIDERS[provider];
  const m = p?.models.find((m) => m.id === model);
  return m ?? null;
}

export function estimateModelCost(usage: TokenUsage, costs: ReturnType<typeof getModelCosts>): number | null {
  if (!costs) return null;
  const free = costs.costPer1kInput === 0 && costs.costPer1kOutput === 0;
  return estimateTokenCost(usage, {
    inputPerMillion: costs.costPer1kInput * 1000,
    outputPerMillion: costs.costPer1kOutput * 1000,
    cachedInputPerMillion: free ? 0 : null,
    cacheWritePerMillion: free ? 0 : null,
  });
}
