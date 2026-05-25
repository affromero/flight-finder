import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// Mock child_process — vi.mock handles both static and dynamic imports
const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...args) };
});

// Mock the openai SDK so local provider extract paths can assert what baseURL
// the client was constructed with (issue #84: 404 page not found from Ollama
// when customBaseUrl lacked the /v1 suffix). The default export is invoked
// with `new`, so the implementation must be a regular function expression:
// arrow functions cannot be called as constructors.
const mockOpenAIConstructor = vi.fn();
const mockChatCompletionsCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn(function (this: unknown, opts: { apiKey?: string; baseURL?: string }) {
    mockOpenAIConstructor(opts);
    return {
      chat: { completions: { create: mockChatCompletionsCreate } },
    };
  }),
}));

// Must import after mocks
const { EXTRACTION_PROVIDERS, LOCAL_PROVIDERS, detectAvailableProviders, ensureV1Suffix, filterCliStderr, isLocalProviderReachable } = await import(
  './ai-registry'
);

/** Create a fake ChildProcess-like EventEmitter with stdin/stdout/stderr */
function createFakeProc() {
  const proc = new EventEmitter() as EventEmitter & Pick<ChildProcess, 'stdin' | 'stdout' | 'stderr'>;
  proc.stdout = new EventEmitter() as ChildProcess['stdout'];
  proc.stderr = new EventEmitter() as ChildProcess['stderr'];
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as ChildProcess['stdin'];
  return proc;
}

describe('ai-registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectAvailableProviders', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save and clear LLM env vars (setup.ts sets dummy keys globally)
      for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'SELF_HOSTED']) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      // Restore original env
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    });

    it('detects API-key providers when env vars are set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-test';

      const providers = await detectAvailableProviders();

      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).not.toContain('google');
    });

    it('auto-detects CLI providers when binary and auth exist', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
      mockExistsSync.mockReturnValue(true);

      const providers = await detectAvailableProviders();

      expect(providers).toContain('claude-code');
      expect(mockExecSync).toHaveBeenCalledWith('which claude', {
        stdio: 'ignore',
      });
    });

    it('skips CLI providers when binary exists but no auth', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/codex'));
      mockExistsSync.mockReturnValue(false);

      const providers = await detectAvailableProviders();

      expect(providers).not.toContain('codex');
      expect(providers).not.toContain('claude-code');
    });

    it('skips CLI providers when binary is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const providers = await detectAvailableProviders();

      expect(providers).not.toContain('codex');
      expect(providers).not.toContain('claude-code');
    });

    it('includes local providers when SELF_HOSTED=true and reachable', async () => {
      process.env.SELF_HOSTED = 'true';
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const providers = await detectAvailableProviders();

      expect(providers).toContain('ollama');
      expect(providers).toContain('llamacpp');
      expect(providers).toContain('vllm');
      vi.unstubAllGlobals();
    });

    it('excludes local providers when SELF_HOSTED=true but unreachable', async () => {
      process.env.SELF_HOSTED = 'true';
      const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      const providers = await detectAvailableProviders();

      expect(providers).not.toContain('ollama');
      expect(providers).not.toContain('llamacpp');
      expect(providers).not.toContain('vllm');
      vi.unstubAllGlobals();
    });

    it('excludes local providers when SELF_HOSTED is not set', async () => {
      const providers = await detectAvailableProviders();

      expect(providers).not.toContain('ollama');
      expect(providers).not.toContain('llamacpp');
    });
  });

  describe('allowCustomModel', () => {
    it('is enabled for openai, google, ollama, llamacpp, and vllm providers', () => {
      expect(EXTRACTION_PROVIDERS.openai!.allowCustomModel).toBe(true);
      expect(EXTRACTION_PROVIDERS.google!.allowCustomModel).toBe(true);
      expect(EXTRACTION_PROVIDERS.ollama!.allowCustomModel).toBe(true);
      expect(EXTRACTION_PROVIDERS.llamacpp!.allowCustomModel).toBe(true);
      expect(EXTRACTION_PROVIDERS.vllm!.allowCustomModel).toBe(true);
    });

    it('is not enabled for other providers', () => {
      expect(EXTRACTION_PROVIDERS.anthropic!.allowCustomModel).toBeUndefined();
    });
  });

  describe('local providers', () => {
    it('ollama provider exists with correct config', () => {
      const ollama = EXTRACTION_PROVIDERS.ollama!;
      expect(ollama.displayName).toBe('Ollama');
      expect(ollama.allowCustomBaseUrl).toBe(true);
      expect(ollama.defaultBaseUrl).toBe('http://localhost:11434/v1');
      expect(ollama.models).toHaveLength(0);
      expect(ollama.envKey).toBeUndefined();
    });

    it('llamacpp provider exists with correct config', () => {
      const llamacpp = EXTRACTION_PROVIDERS.llamacpp!;
      expect(llamacpp.displayName).toBe('llama.cpp');
      expect(llamacpp.allowCustomBaseUrl).toBe(true);
      expect(llamacpp.defaultBaseUrl).toBe('http://localhost:8080/v1');
      expect(llamacpp.models).toHaveLength(0);
      expect(llamacpp.envKey).toBeUndefined();
    });

    it('openai provider has allowCustomBaseUrl', () => {
      expect(EXTRACTION_PROVIDERS.openai!.allowCustomBaseUrl).toBe(true);
    });

    it('vllm provider exists with correct config', () => {
      const vllm = EXTRACTION_PROVIDERS.vllm!;
      expect(vllm.displayName).toBe('vLLM');
      expect(vllm.allowCustomBaseUrl).toBe(true);
      expect(vllm.defaultBaseUrl).toBe('http://localhost:8000/v1');
      expect(vllm.models).toHaveLength(0);
      expect(vllm.envKey).toBeUndefined();
    });

    it('LOCAL_PROVIDERS includes ollama, llamacpp, and vllm', () => {
      expect(LOCAL_PROVIDERS.has('ollama')).toBe(true);
      expect(LOCAL_PROVIDERS.has('llamacpp')).toBe(true);
      expect(LOCAL_PROVIDERS.has('vllm')).toBe(true);
      expect(LOCAL_PROVIDERS.has('openai')).toBe(false);
    });
  });

  describe('codex extract — ENOENT handling', () => {
    it('rejects with actionable message when codex binary is missing', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const extractPromise = EXTRACTION_PROVIDERS.codex!.extract(
        '',
        'codex',
        'system',
        'user'
      );

      // Give the dynamic import a tick to resolve
      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      // Simulate ENOENT error
      const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      fakeProc.emit('error', err);

      await expect(extractPromise).rejects.toThrow(
        /codex CLI not found.*Restart the container/
      );
    });
  });

  describe('claude-code extract — ENOENT handling', () => {
    it('rejects with actionable message when claude binary is missing', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const extractPromise = EXTRACTION_PROVIDERS['claude-code']!.extract(
        '',
        'sonnet',
        'system',
        'user'
      );

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      fakeProc.emit('error', err);

      await expect(extractPromise).rejects.toThrow(
        /claude CLI not found.*Restart the container/
      );
    });
  });

  describe('filterCliStderr', () => {
    it('strips PATH warning lines from stderr', () => {
      const stderr = 'could not update PATH\nError: something went wrong\ncould not update PATH to include /usr/bin';
      expect(filterCliStderr(stderr)).toBe('Error: something went wrong');
    });

    it('returns empty string when all lines are PATH warnings', () => {
      expect(filterCliStderr('could not update PATH')).toBe('');
    });

    it('preserves non-warning lines unchanged', () => {
      expect(filterCliStderr('real error message')).toBe('real error message');
    });
  });

  describe('codex extract — 401 auth hint', () => {
    it('includes auth hint when stderr contains 401', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const extractPromise = EXTRACTION_PROVIDERS.codex!.extract(
        '',
        'codex',
        'system',
        'user'
      );

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      // Emit 401 on stderr, then close with error
      fakeProc.stderr!.emit('data', Buffer.from('401 Unauthorized'));
      fakeProc.emit('close', 1);

      await expect(extractPromise).rejects.toThrow(
        /ensure codex is authenticated on the host via `codex auth`/
      );
    });

    it('does not include auth hint for non-401 errors', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const extractPromise = EXTRACTION_PROVIDERS.codex!.extract(
        '',
        'codex',
        'system',
        'user'
      );

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      fakeProc.stderr!.emit('data', Buffer.from('some other error'));
      fakeProc.emit('close', 1);

      await expect(extractPromise).rejects.toThrow('codex CLI exited 1: some other error');
      await expect(extractPromise).rejects.not.toThrow(/codex auth/);
    });
  });

  describe('codex extract passes env to spawn', () => {
    it('includes process.env in spawn options', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const extractPromise = EXTRACTION_PROVIDERS.codex!.extract(
        '',
        'codex',
        'system',
        'user'
      );

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      // Verify spawn was called with exec subcommand and env
      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining(['exec', '-', '--skip-git-repo-check', '--ephemeral']),
        expect.objectContaining({
          env: expect.objectContaining({ PATH: expect.any(String) }),
        })
      );

      // Clean up: resolve the promise
      fakeProc.emit('close', 0);
      await extractPromise.catch(() => {});
    });
  });

  describe('ensureV1Suffix', () => {
    it('appends /v1 to a host without a path', () => {
      expect(ensureV1Suffix('http://localhost:11434')).toBe('http://localhost:11434/v1');
    });

    it('appends /v1 to a host with a trailing slash', () => {
      expect(ensureV1Suffix('http://localhost:11434/')).toBe('http://localhost:11434/v1');
    });

    it('is idempotent when /v1 is already present', () => {
      expect(ensureV1Suffix('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    });

    it('strips a trailing slash after /v1', () => {
      expect(ensureV1Suffix('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    });

    it('handles host.docker.internal style addresses', () => {
      expect(ensureV1Suffix('http://host.docker.internal:11434')).toBe(
        'http://host.docker.internal:11434/v1',
      );
    });
  });

  // Regression for issue #84: a customBaseUrl saved without /v1 sent the
  // OpenAI SDK to <host>/chat/completions, which Ollama answers with its
  // catchall 404. Assert that every local provider passes a /v1 suffixed
  // baseURL into the SDK constructor regardless of what the caller supplied.
  describe('local provider extract: /v1 suffix normalization (issue #84)', () => {
    const savedOllamaHost = process.env.OLLAMA_HOST;

    beforeEach(() => {
      mockOpenAIConstructor.mockClear();
      mockChatCompletionsCreate.mockReset();
      mockChatCompletionsCreate.mockResolvedValue({
        choices: [{ message: { content: '{"parsed": null, "confidence": "low", "ambiguities": []}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      delete process.env.OLLAMA_HOST;
    });

    afterEach(() => {
      if (savedOllamaHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = savedOllamaHost;
    });

    it('ollama: appends /v1 when caller passes baseUrl without it', async () => {
      await EXTRACTION_PROVIDERS.ollama!.extract(
        '',
        'llama3.1:8b',
        'system',
        'user',
        { baseUrl: 'http://host.docker.internal:11434' },
      );
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://host.docker.internal:11434/v1' }),
      );
    });

    it('ollama: keeps /v1 when caller already supplied it', async () => {
      await EXTRACTION_PROVIDERS.ollama!.extract(
        '',
        'llama3.1:8b',
        'system',
        'user',
        { baseUrl: 'http://host.docker.internal:11434/v1' },
      );
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://host.docker.internal:11434/v1' }),
      );
    });

    it('ollama: appends /v1 when only OLLAMA_HOST env is set (no /v1)', async () => {
      process.env.OLLAMA_HOST = 'http://host.docker.internal:11434';
      await EXTRACTION_PROVIDERS.ollama!.extract('', 'llama3.1:8b', 'system', 'user');
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://host.docker.internal:11434/v1' }),
      );
    });

    it('ollama: falls back to localhost:11434/v1 when nothing is configured', async () => {
      await EXTRACTION_PROVIDERS.ollama!.extract('', 'llama3.1:8b', 'system', 'user');
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://localhost:11434/v1' }),
      );
    });

    it('llamacpp: appends /v1 when caller passes baseUrl without it', async () => {
      await EXTRACTION_PROVIDERS.llamacpp!.extract(
        '',
        'gguf-model',
        'system',
        'user',
        { baseUrl: 'http://host.docker.internal:8080' },
      );
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://host.docker.internal:8080/v1' }),
      );
    });

    it('vllm: appends /v1 when caller passes baseUrl without it', async () => {
      await EXTRACTION_PROVIDERS.vllm!.extract(
        '',
        'mistral-7b',
        'system',
        'user',
        { baseUrl: 'http://host.docker.internal:8000' },
      );
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://host.docker.internal:8000/v1' }),
      );
    });
  });

  // Issue #84 follow up: enabling responseFormat must thread through every
  // OpenAI compatible extract path so small models (Ollama, llama.cpp, vLLM)
  // get constrained generation. Without it the parser regex would occasionally
  // find no JSON in the response and bail.
  describe('responseFormat: json_object plumbing (issue #84)', () => {
    beforeEach(() => {
      mockOpenAIConstructor.mockClear();
      mockChatCompletionsCreate.mockReset();
      mockChatCompletionsCreate.mockResolvedValue({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    it('openai: passes response_format when caller opts in', async () => {
      await EXTRACTION_PROVIDERS.openai!.extract(
        'sk-test',
        'gpt-4.1-mini',
        'system',
        'user',
        { responseFormat: 'json_object' },
      );
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });

    it('openai: omits response_format when caller does not opt in', async () => {
      await EXTRACTION_PROVIDERS.openai!.extract('sk-test', 'gpt-4.1-mini', 'system', 'user');
      const callArgs = mockChatCompletionsCreate.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('response_format');
    });

    it('ollama: passes response_format when caller opts in', async () => {
      await EXTRACTION_PROVIDERS.ollama!.extract(
        '',
        'llama3.1:8b',
        'system',
        'user',
        { baseUrl: 'http://localhost:11434/v1', responseFormat: 'json_object' },
      );
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });

    it('llamacpp: passes response_format when caller opts in', async () => {
      await EXTRACTION_PROVIDERS.llamacpp!.extract(
        '',
        'gguf-model',
        'system',
        'user',
        { responseFormat: 'json_object' },
      );
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });

    it('vllm: passes response_format when caller opts in', async () => {
      await EXTRACTION_PROVIDERS.vllm!.extract(
        '',
        'mistral-7b',
        'system',
        'user',
        { responseFormat: 'json_object' },
      );
      expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });
  });

  // Issue #86: ExtractOptions.timeoutMs lets the admin override the default
  // 90s abort timeout from the DB. Every SDK provider's extract path must
  // honour it, with EXTRACT_TIMEOUT_MS as the fallback when unset.
  describe('timeoutMs plumbing (issue #86)', () => {
    let timeoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockOpenAIConstructor.mockClear();
      mockChatCompletionsCreate.mockReset();
      mockChatCompletionsCreate.mockResolvedValue({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
    });

    it('ollama: uses options.timeoutMs when supplied', async () => {
      await EXTRACTION_PROVIDERS.ollama!.extract(
        '',
        'qwen3:4b',
        'system',
        'user',
        { baseUrl: 'http://localhost:11434/v1', timeoutMs: 240_000 },
      );
      expect(timeoutSpy).toHaveBeenCalledWith(240_000);
    });

    it('ollama: falls back to EXTRACT_TIMEOUT_MS when timeoutMs is unset', async () => {
      await EXTRACTION_PROVIDERS.ollama!.extract('', 'qwen3:4b', 'system', 'user');
      expect(timeoutSpy).toHaveBeenCalledWith(90_000);
    });

    it('openai: uses options.timeoutMs when supplied', async () => {
      await EXTRACTION_PROVIDERS.openai!.extract(
        'sk-test',
        'gpt-4.1-mini',
        'system',
        'user',
        { timeoutMs: 180_000 },
      );
      expect(timeoutSpy).toHaveBeenCalledWith(180_000);
    });

    it('llamacpp: uses options.timeoutMs when supplied', async () => {
      await EXTRACTION_PROVIDERS.llamacpp!.extract(
        '',
        'gguf-model',
        'system',
        'user',
        { timeoutMs: 300_000 },
      );
      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    });

    it('vllm: uses options.timeoutMs when supplied', async () => {
      await EXTRACTION_PROVIDERS.vllm!.extract(
        '',
        'mistral-7b',
        'system',
        'user',
        { timeoutMs: 120_000 },
      );
      expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    });
  });

  describe('isLocalProviderReachable', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns true when provider responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      expect(await isLocalProviderReachable('ollama')).toBe(true);
    });

    it('returns false when provider responds with non-200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      expect(await isLocalProviderReachable('ollama')).toBe(false);
    });

    it('returns false when fetch throws (unreachable)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      expect(await isLocalProviderReachable('llamacpp')).toBe(false);
    });

    it('returns false for unknown providers', async () => {
      expect(await isLocalProviderReachable('nonexistent')).toBe(false);
    });

    it('pings /api/tags for ollama, /v1/models for others', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await isLocalProviderReachable('ollama');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/tags'),
        expect.any(Object)
      );

      mockFetch.mockClear();
      await isLocalProviderReachable('vllm');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.any(Object)
      );
    });
  });
});

describe('EXTRACT_TIMEOUT_MS env parsing (issue #65)', () => {
  const ORIGINAL = process.env.EXTRACT_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EXTRACT_TIMEOUT_MS;
    else process.env.EXTRACT_TIMEOUT_MS = ORIGINAL;
    vi.resetModules();
  });

  it('defaults to 90_000 ms when env var is unset', async () => {
    delete process.env.EXTRACT_TIMEOUT_MS;
    vi.resetModules();
    const mod = await import('./ai-registry');
    expect(mod.EXTRACT_TIMEOUT_MS).toBe(90_000);
  });

  it('respects a valid env var override', async () => {
    process.env.EXTRACT_TIMEOUT_MS = '30000';
    vi.resetModules();
    const mod = await import('./ai-registry');
    expect(mod.EXTRACT_TIMEOUT_MS).toBe(30_000);
  });

  it('falls back to 90_000 when env var is not a number', async () => {
    process.env.EXTRACT_TIMEOUT_MS = 'not-a-number';
    vi.resetModules();
    const mod = await import('./ai-registry');
    expect(mod.EXTRACT_TIMEOUT_MS).toBe(90_000);
  });

  it('falls back to 90_000 when env var is zero or negative', async () => {
    process.env.EXTRACT_TIMEOUT_MS = '0';
    vi.resetModules();
    let mod = await import('./ai-registry');
    expect(mod.EXTRACT_TIMEOUT_MS).toBe(90_000);

    process.env.EXTRACT_TIMEOUT_MS = '-5000';
    vi.resetModules();
    mod = await import('./ai-registry');
    expect(mod.EXTRACT_TIMEOUT_MS).toBe(90_000);
  });
});
