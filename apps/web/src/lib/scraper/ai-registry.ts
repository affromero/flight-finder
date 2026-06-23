import type Anthropic from '@anthropic-ai/sdk';

import {
  PROVIDER_METADATA,
  CLI_PROVIDERS,
  LOCAL_PROVIDERS,
  type ModelInfo,
  type ProviderMeta,
} from './provider-metadata';
import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/secret-crypto';

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

/** Structural subset of ExtractionConfig carrying the encrypted per-provider
 *  key columns. Typed as a subset (not the generated Prisma type) so this
 *  module stays decoupled from the generated client path. */
export type StoredKeyConfig = {
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  googleApiKey?: string | null;
};

/** Env-backed provider -> the ExtractionConfig column that stores its
 *  admin-entered key (encrypted). Only the three providers with an `envKey`
 *  appear here; CLI/local providers need no key. */
export const STORED_KEY_FIELD: Record<string, keyof StoredKeyConfig> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
  google: 'googleApiKey',
};

/**
 * Resolve a provider's API key. An admin-entered key stored in the DB
 * (decrypted) takes precedence over the environment variable, so a self-hosted
 * user can configure a key in the GUI without editing .env or restarting the
 * stack (#149). A stored value that fails to decrypt (eg. ADMIN_SESSION_SECRET
 * was rotated) is treated as absent and falls through to the env var. Returns
 * '' when neither source has a key (CLI/local providers, which need none).
 */
export function resolveApiKey(provider: string, config: StoredKeyConfig | null | undefined): string {
  const field = STORED_KEY_FIELD[provider];
  if (field && config) {
    const encrypted = config[field];
    if (encrypted) {
      const decrypted = decryptSecret(encrypted);
      if (decrypted) return decrypted;
    }
  }
  const envKey = PROVIDER_METADATA[provider]?.envKey;
  return (envKey ? process.env[envKey] : '') ?? '';
}

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionResult {
  content: string;
  usage: ExtractionUsage;
}

export interface ExtractOptions {
  baseUrl?: string;
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
  anthropic: {
    ...PROVIDER_METADATA.anthropic!,
    extract: async (apiKey, model, systemPrompt, userPrompt, options) => {
      // Dynamic import like the other providers (openai, google): a static
      // import makes Turbopack resolve the externalized SDK at build time, which
      // fails in the monorepo Docker install where npm hoists it to the
      // workspace, not the root. The type-only import above keeps Anthropic.* types.
      const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
      const client = new AnthropicSdk({ apiKey });
      const response = await client.messages.create(
        {
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: AbortSignal.timeout(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS) },
      );

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content: text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  },
  openai: {
    ...PROVIDER_METADATA.openai!,
    extract: async (apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey: apiKey || 'unused',
        baseURL: options?.baseUrl || process.env.OPENAI_BASE_URL || undefined,
      });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
          ...(options?.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' as const } }
            : {}),
        },
        { signal: AbortSignal.timeout(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS) },
      );

      return {
        content: response.choices[0]?.message.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    },
  },
  ollama: {
    ...PROVIDER_METADATA.ollama!,
    extract: async (_apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const rawBaseURL = options?.baseUrl
        || process.env.OLLAMA_HOST
        || 'http://localhost:11434';
      const baseURL = ensureV1Suffix(rawBaseURL);
      const client = new OpenAI({ apiKey: 'unused', baseURL });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
          ...(options?.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' as const } }
            : {}),
        },
        { signal: AbortSignal.timeout(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS) },
      );

      return {
        content: response.choices[0]?.message.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    },
  },
  llamacpp: {
    ...PROVIDER_METADATA.llamacpp!,
    extract: async (_apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const baseURL = ensureV1Suffix(options?.baseUrl || 'http://localhost:8080');
      const client = new OpenAI({ apiKey: 'unused', baseURL });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
          ...(options?.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' as const } }
            : {}),
        },
        { signal: AbortSignal.timeout(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS) },
      );

      return {
        content: response.choices[0]?.message.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    },
  },
  vllm: {
    ...PROVIDER_METADATA.vllm!,
    extract: async (_apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const baseURL = ensureV1Suffix(options?.baseUrl || 'http://localhost:8000');
      const client = new OpenAI({ apiKey: 'unused', baseURL });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
          ...(options?.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' as const } }
            : {}),
        },
        { signal: AbortSignal.timeout(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS) },
      );

      return {
        content: response.choices[0]?.message.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    },
  },
  google: {
    ...PROVIDER_METADATA.google!,
    extract: async (apiKey, model, systemPrompt, userPrompt, options) => {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const genModel = genAI.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
      });

      // @google/generative-ai 0.24+ accepts SingleRequestOptions as the second
      // arg with native `signal` and `timeout` fields. Native signal aborts
      // the underlying fetch (better than Promise.race which would leak).
      const timeoutMs = options?.timeoutMs ?? EXTRACT_TIMEOUT_MS;
      const result = await genModel.generateContent(userPrompt, {
        signal: AbortSignal.timeout(timeoutMs),
        timeout: timeoutMs,
      });
      const response = result.response;

      return {
        content: response.text(),
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  },
  'claude-code': {
    ...PROVIDER_METADATA['claude-code']!,
    extract: async (_apiKey, model, systemPrompt, userPrompt) => {
      const { spawn } = await import(/* webpackIgnore: true */ 'child_process');

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const result = await new Promise<string>((resolve, reject) => {
        const env = { ...process.env };
        // Force the CLI onto its own Max-subscription auth. Drop the API key AND
        // any inherited base-URL / auth-token override that would otherwise
        // redirect the spawned `claude` at a different endpoint (a host proxy,
        // or a test harness's mock server). A stray ANTHROPIC_BASE_URL silently
        // breaks extraction with an llm_error. Issue #139 follow-up.
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_BASE_URL;
        // Extraction is pure text-in / JSON-out and needs no agentic capability.
        // The input is adversarial scraped HTML, so run the agent locked down:
        // deny every tool (overrides any pre-approval in the host's
        // ~/.claude config) and force the default permission mode, which in
        // non-interactive --print mode denies anything not explicitly allowed.
        // Together a prompt injection in the page cannot make the agent run a
        // shell command, write a file, or read and exfiltrate host credentials.
        const proc = spawn('claude', [
          '--print',
          '--model', model,
          '--permission-mode', 'default',
          '--disallowedTools', 'Bash,Edit,MultiEdit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite',
        ], {
          timeout: 240_000,
          env,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        proc.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        proc.on('close', (code) => {
          if (code !== 0) {
            const filtered = filterCliStderr(stderr);
            reject(new Error(`claude CLI exited ${code}: ${filtered}`));
          } else {
            resolve(stdout.trim());
          }
        });
        proc.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            reject(new Error('claude CLI not found. Restart the container to trigger install.'));
          } else {
            reject(err);
          }
        });
        proc.stdin.write(fullPrompt);
        proc.stdin.end();
      });

      return {
        content: result,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
  codex: {
    ...PROVIDER_METADATA.codex!,
    extract: async (_apiKey, _model, systemPrompt, userPrompt) => {
      const { spawn } = await import(/* webpackIgnore: true */ 'child_process');

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const { mkdtempSync, readFileSync, unlinkSync } = await import(/* webpackIgnore: true */ 'fs');
      const { join } = await import(/* webpackIgnore: true */ 'path');
      const os = await import(/* webpackIgnore: true */ 'os');

      const tmpFile = join(mkdtempSync(join(os.tmpdir(), 'codex-')), 'output.txt');

      const result = await new Promise<string>((resolve, reject) => {
        // Pin the read-only sandbox: model-generated shell commands cannot write
        // files, execute side effects, or reach the network. codex exec is
        // inherently agentic and cannot be reduced to pure inference, so a
        // residual read-only exfil risk remains (the agent could still read a
        // file and emit it); the admin UI warns about this and the scraped HTML
        // is sanitized and fenced as untrusted data before it reaches here.
        const proc = spawn('codex', [
          'exec', '-',
          '--skip-git-repo-check',
          '--ephemeral',
          '-s', 'read-only',
          '-o', tmpFile,
        ], {
          timeout: 240_000,
          env: { ...process.env },
        });

        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        proc.on('close', (code) => {
          const filtered = filterCliStderr(stderr);
          const hint = filtered.includes('401') || filtered.includes('Unauthorized')
            ? ' (ensure codex is authenticated on the host via `codex auth` and ~/.codex is readable)'
            : '';
          try {
            const output = readFileSync(tmpFile, 'utf-8').trim();
            unlinkSync(tmpFile);
            if (code !== 0) reject(new Error(`codex CLI exited ${code}: ${filtered}${hint}`));
            else resolve(output);
          } catch {
            reject(new Error(`codex CLI exited ${code}: ${filtered}${hint}`));
          }
        });
        proc.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            reject(new Error('codex CLI not found. Restart the container to trigger install.'));
          } else {
            reject(err);
          }
        });
        proc.stdin.write(fullPrompt);
        proc.stdin.end();
      });

      return {
        content: result,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
};

/** Check that a CLI provider has auth configured, not just the binary installed */
async function hasCliAuth(provider: string): Promise<boolean> {
  const { existsSync } = await import(/* webpackIgnore: true */ 'fs');
  const { homedir } = await import(/* webpackIgnore: true */ 'os');
  const { join } = await import(/* webpackIgnore: true */ 'path');
  const home = homedir();

  switch (provider) {
    case 'codex':
      return existsSync(join(home, '.codex', 'auth.json'));
    case 'claude-code':
      return existsSync(join(home, '.claude.json'))
        || existsSync(join(home, '.claude', 'credentials.json'))
        || existsSync(join(home, '.claude', '.credentials.json'));
    default:
      return false;
  }
}

/**
 * Ping a local provider to check if it's actually reachable.
 * With no `overrideBaseUrl`, sources the base URL the way extraction does
 * (env/default) so the status probe agrees with what a real extract call hits;
 * for Ollama that means honouring OLLAMA_HOST (install.sh sets it to
 * host.docker.internal in Docker), since probing the localhost default would
 * falsely report "unreachable" inside a container (issue #139 follow-up).
 * Pass `overrideBaseUrl` to probe a specific URL instead, e.g. validating a
 * customBaseUrl at config-save time (#153); that path uses a longer timeout
 * since it is an interactive save, not a background status sweep.
 */
export async function isLocalProviderReachable(provider: string, overrideBaseUrl?: string | null): Promise<boolean> {
  const config = EXTRACTION_PROVIDERS[provider];
  if (!config) return false;

  const envBase = provider === 'ollama' ? process.env.OLLAMA_HOST : undefined;
  const source = overrideBaseUrl || envBase || config.defaultBaseUrl || '';
  const baseUrl = source.replace(/\/v1\/?$/, '');
  const endpoint = provider === 'ollama'
    ? `${baseUrl || 'http://localhost:11434'}/api/tags`
    : `${baseUrl || 'http://localhost:8000'}/v1/models`;

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(overrideBaseUrl ? 5000 : 3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function detectAvailableProviders(
  storedConfig?: (StoredKeyConfig & { customBaseUrl?: string | null }) | null,
): Promise<string[]> {
  const available: string[] = [];

  const isSelfHosted = process.env.SELF_HOSTED === 'true';

  // A stored key/customBaseUrl can make a provider available even when the env
  // var is unset (#149). Callers that pass nothing get a fresh DB read so the
  // status reflects keys saved after first-run setup; `null` skips the read.
  const cfg =
    storedConfig !== undefined
      ? storedConfig
      : await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });

  for (const [key] of Object.entries(EXTRACTION_PROVIDERS)) {
    // Local providers: only on self-hosted, and only if reachable
    if (LOCAL_PROVIDERS.has(key)) {
      if (isSelfHosted && await isLocalProviderReachable(key)) {
        available.push(key);
      }
      continue;
    }
    const cliBinary = CLI_PROVIDERS[key];
    if (cliBinary) {
      try {
        const { execSync } = await import('child_process');
        execSync(`which ${cliBinary}`, { stdio: 'ignore' });
        if (await hasCliAuth(key)) {
          available.push(key);
        }
      } catch {
        // CLI not found
      }
      continue;
    }
    // Env-backed (anthropic/openai/google): a stored key OR an env key makes it
    // available; openai is also usable via a custom local endpoint.
    const hasKey = !!resolveApiKey(key, cfg);
    const hasLocalEndpoint = key === 'openai' && (cfg?.customBaseUrl || process.env.OPENAI_BASE_URL);
    if (hasKey || hasLocalEndpoint) {
      available.push(key);
    }
  }

  return available;
}

export function getModelCosts(
  provider: string,
  model: string
): { costPer1kInput: number; costPer1kOutput: number } {
  const p = EXTRACTION_PROVIDERS[provider];
  const m = p?.models.find((m) => m.id === model);
  return m ?? { costPer1kInput: 0, costPer1kOutput: 0 };
}
