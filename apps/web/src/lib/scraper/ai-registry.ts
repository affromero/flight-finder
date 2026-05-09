import Anthropic from '@anthropic-ai/sdk';

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

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionResult {
  content: string;
  usage: ExtractionUsage;
}

interface ModelInfo {
  id: string;
  name: string;
  costPer1kInput: number;
  costPer1kOutput: number;
}

export interface ExtractOptions {
  baseUrl?: string;
}

interface ProviderConfig {
  displayName: string;
  envKey?: string;
  models: ModelInfo[];
  allowCustomModel?: boolean;
  allowCustomBaseUrl?: boolean;
  defaultBaseUrl?: string;
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

export const EXTRACTION_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    displayName: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        costPer1kInput: 0.001,
        costPer1kOutput: 0.005,
      },
      {
        id: 'claude-sonnet-4-6-20250514',
        name: 'Claude Sonnet 4.6',
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      },
    ],
    extract: async (apiKey, model, systemPrompt, userPrompt) => {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create(
        {
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
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
    displayName: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    models: [
      {
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 Mini',
        costPer1kInput: 0.0004,
        costPer1kOutput: 0.0016,
      },
    ],
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
        },
        { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
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
    displayName: 'Ollama',
    envKey: undefined,
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    models: [],
    extract: async (_apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const baseURL = options?.baseUrl
        || (process.env.OLLAMA_HOST ? process.env.OLLAMA_HOST + '/v1' : 'http://localhost:11434/v1');
      const client = new OpenAI({ apiKey: 'unused', baseURL });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
        },
        { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
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
    displayName: 'llama.cpp',
    envKey: undefined,
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8080/v1',
    models: [],
    extract: async (_apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const baseURL = options?.baseUrl || 'http://localhost:8080/v1';
      const client = new OpenAI({ apiKey: 'unused', baseURL });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
        },
        { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
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
    displayName: 'vLLM',
    envKey: undefined,
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8000/v1',
    models: [],
    extract: async (_apiKey, model, systemPrompt, userPrompt, options) => {
      const { default: OpenAI } = await import('openai');
      const baseURL = options?.baseUrl || 'http://localhost:8000/v1';
      const client = new OpenAI({ apiKey: 'unused', baseURL });
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
        },
        { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
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
    displayName: 'Google',
    envKey: 'GOOGLE_AI_API_KEY',
    models: [
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        costPer1kInput: 0.00015,
        costPer1kOutput: 0.0035,
      },
    ],
    extract: async (apiKey, model, systemPrompt, userPrompt) => {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const genModel = genAI.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
      });

      // @google/generative-ai 0.24+ accepts SingleRequestOptions as the second
      // arg with native `signal` and `timeout` fields. Native signal aborts
      // the underlying fetch (better than Promise.race which would leak).
      const result = await genModel.generateContent(userPrompt, {
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
        timeout: EXTRACT_TIMEOUT_MS,
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
    displayName: 'Claude Code (Max)',
    envKey: undefined,
    models: [
      { id: 'sonnet', name: 'Claude Sonnet (via CLI)', costPer1kInput: 0, costPer1kOutput: 0 },
      { id: 'opus', name: 'Claude Opus (via CLI)', costPer1kInput: 0, costPer1kOutput: 0 },
    ],
    extract: async (_apiKey, model, systemPrompt, userPrompt) => {
      const { spawn } = await import(/* webpackIgnore: true */ 'child_process');

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const result = await new Promise<string>((resolve, reject) => {
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        const proc = spawn('claude', ['--print', '--model', model], {
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
    displayName: 'OpenAI Codex (CLI)',
    envKey: undefined,
    models: [
      { id: 'codex', name: 'Codex CLI', costPer1kInput: 0, costPer1kOutput: 0 },
    ],
    extract: async (_apiKey, _model, systemPrompt, userPrompt) => {
      const { spawn } = await import(/* webpackIgnore: true */ 'child_process');

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const { mkdtempSync, readFileSync, unlinkSync } = await import(/* webpackIgnore: true */ 'fs');
      const { join } = await import(/* webpackIgnore: true */ 'path');
      const os = await import(/* webpackIgnore: true */ 'os');

      const tmpFile = join(mkdtempSync(join(os.tmpdir(), 'codex-')), 'output.txt');

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn('codex', [
          'exec', '-',
          '--skip-git-repo-check',
          '--ephemeral',
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

export const CLI_PROVIDERS: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

export const LOCAL_PROVIDERS = new Set(['ollama', 'llamacpp', 'vllm']);

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

/** Ping a local provider to check if it's actually reachable (3s timeout). */
export async function isLocalProviderReachable(provider: string): Promise<boolean> {
  const config = EXTRACTION_PROVIDERS[provider];
  if (!config) return false;

  const baseUrl = config.defaultBaseUrl?.replace(/\/v1\/?$/, '') ?? '';
  const endpoint = provider === 'ollama'
    ? `${baseUrl || 'http://localhost:11434'}/api/tags`
    : `${baseUrl || 'http://localhost:8000'}/v1/models`;

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function detectAvailableProviders(): Promise<string[]> {
  const available: string[] = [];

  const isSelfHosted = process.env.SELF_HOSTED === 'true';

  for (const [key, config] of Object.entries(EXTRACTION_PROVIDERS)) {
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
    const hasKey = config.envKey && process.env[config.envKey];
    const hasLocalEndpoint = key === 'openai' && process.env.OPENAI_BASE_URL;
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
