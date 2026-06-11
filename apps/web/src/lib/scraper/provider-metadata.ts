// Client-safe provider metadata: display names, models, costs, and capability
// flags. Kept separate from ai-registry.ts (which carries the server-only
// extract functions and the LLM SDK imports) so the settings, setup, and admin
// client pages can render the provider UI without dragging the SDKs into the
// client bundle. That bundling is what broke the build on @anthropic-ai/sdk
// 0.100, whose agent toolset imports node: builtins.

export interface ModelInfo {
  id: string;
  name: string;
  costPer1kInput: number;
  costPer1kOutput: number;
}

export interface ProviderMeta {
  displayName: string;
  envKey?: string;
  models: ModelInfo[];
  allowCustomModel?: boolean;
  allowCustomBaseUrl?: boolean;
  defaultBaseUrl?: string;
}

export const PROVIDER_METADATA: Record<string, ProviderMeta> = {
  anthropic: {
    displayName: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', costPer1kInput: 0.001, costPer1kOutput: 0.005 },
      { id: 'claude-sonnet-4-6-20250514', name: 'Claude Sonnet 4.6', costPer1kInput: 0.003, costPer1kOutput: 0.015 },
    ],
  },
  openai: {
    displayName: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    models: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', costPer1kInput: 0.0004, costPer1kOutput: 0.0016 }],
  },
  ollama: {
    displayName: 'Ollama',
    envKey: undefined,
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    models: [],
  },
  llamacpp: {
    displayName: 'llama.cpp',
    envKey: undefined,
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8080/v1',
    models: [],
  },
  vllm: {
    displayName: 'vLLM',
    envKey: undefined,
    allowCustomModel: true,
    allowCustomBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8000/v1',
    models: [],
  },
  google: {
    displayName: 'Google',
    envKey: 'GOOGLE_AI_API_KEY',
    allowCustomModel: true,
    models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', costPer1kInput: 0.00015, costPer1kOutput: 0.0035 }],
  },
  'claude-code': {
    displayName: 'Claude Code (Max)',
    envKey: undefined,
    models: [
      { id: 'sonnet', name: 'Claude Sonnet (via CLI)', costPer1kInput: 0, costPer1kOutput: 0 },
      { id: 'opus', name: 'Claude Opus (via CLI)', costPer1kInput: 0, costPer1kOutput: 0 },
    ],
  },
  codex: {
    displayName: 'OpenAI Codex (CLI)',
    envKey: undefined,
    models: [{ id: 'codex', name: 'Codex CLI', costPer1kInput: 0, costPer1kOutput: 0 }],
  },
};

export const CLI_PROVIDERS: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

export const LOCAL_PROVIDERS = new Set(['ollama', 'llamacpp', 'vllm']);
