import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { createStateBoundary } from '@/test/state-fixture';
const persistence = vi.hoisted(() => ({ state: null as ReturnType<typeof createStateBoundary> | null, config: null as Record<string, unknown> | null }));
vi.mock('@/lib/sidedoor/access/store', async () => {
  const { createStateBoundary } = await import('@/test/state-fixture');
  persistence.state = createStateBoundary();
  return { sharedStateStore: persistence.state.store };
});

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

// Provider discovery reads the ExtractionConfig singleton, so Prisma must be
// mocked or the call reaches a real database.
const mockConfigFindFirst = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/prisma', () => {
  const database = { extractionConfig: {
    async findFirst(...args: unknown[]) { persistence.config = await mockConfigFindFirst(...args); return persistence.config; },
    async findUnique() { return persistence.config; },
    async update({ data }: { data: Record<string, unknown> }) { persistence.config = { ...persistence.config, ...data }; return persistence.config; },
  } };
  return { prisma: { ...database, $transaction: async (operation: (value: typeof database) => Promise<unknown>) => operation(database) } };
});

// Must import after mocks
const { EXTRACTION_PROVIDERS, LOCAL_PROVIDERS, detectAvailableProviders, detectProviderReadiness, resolveApiKey, ensureV1Suffix, filterCliStderr, isLocalProviderReachable, getModelCosts, estimateModelCost } = await import(
  './ai-registry'
);
const { initializeProviderCredentials } = await import('@/lib/sidedoor/providers/provider-credentials');
async function configureProvider(
  provider: string,
  values: Record<string, string | number | boolean | null>,
) {
  const { providerVault } = await import('@/lib/sidedoor/providers/provider-credentials');
  const { prisma } = await import('@/lib/prisma');
  await providerVault(prisma).vault.configure(provider, values);
}

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
  it('prices the canonical Sonnet preset without rewriting an invalid historical selection', () => {
    const costs = getModelCosts('anthropic', 'claude-sonnet-4-6');
    expect(costs).toMatchObject({ costPer1kInput: 0.003, costPer1kOutput: 0.015 });
    expect(estimateModelCost({ inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0 }, costs)).toBeCloseTo(0.018);
    expect(getModelCosts('anthropic', 'claude-sonnet-4-6-20250514')).toBeNull();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    persistence.state!.reset();
    persistence.config = null;
    await initializeProviderCredentials();
  });

  describe('detectAvailableProviders', () => {
    beforeEach(() => {
      mockSpawn.mockImplementation(() => { throw new Error('CLI unavailable'); });
      delete process.env.SELF_HOSTED;
    });

    it('detects canonically configured API-key providers', async () => {
      await configureProvider('anthropic', { apiKey: 'stored-anthropic-key' });
      await configureProvider('openai', { apiKey: 'stored-openai-key' });

      const providers = await detectAvailableProviders();

      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).not.toContain('google');
    });

    it('detects CLI providers after a successful version and sign-in check', async () => {
      mockSpawn.mockImplementation((_binary: string, args: string[]) => {
        const proc = createFakeProc();
        queueMicrotask(() => { proc.stdout?.emit('data', Buffer.from(args[0] === '--version' ? '2.1.165' : 'Logged in')); proc.emit('close', 0); });
        return proc;
      });

      const providers = await detectAvailableProviders();

      expect(providers).toContain('claude-code');
      expect(providers).toContain('codex');
    });

    it('does not mark an installed but signed-out CLI ready', async () => {
      mockSpawn.mockImplementation((_binary: string, args: string[]) => {
        const proc = createFakeProc();
        queueMicrotask(() => { proc.stdout?.emit('data', Buffer.from('0.153.4')); proc.emit('close', args[0] === '--version' ? 0 : 1); });
        return proc;
      });

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

    it('detects a provider with a saved key', async () => {
      await configureProvider('google', { apiKey: 'stored-google-key' });

      const providers = await detectAvailableProviders();

      expect(providers).toContain('google');
    });

    it('surfaces database failures and cancellation instead of reporting missing providers', async () => {
      mockConfigFindFirst.mockRejectedValueOnce(new Error('Database unavailable'));
      await expect(detectProviderReadiness()).rejects.toThrow('Database unavailable');
      const controller = new AbortController();
      controller.abort(new Error('Discovery cancelled'));
      await expect(detectProviderReadiness(controller.signal)).rejects.toThrow('Discovery cancelled');
    });

    it('does not report an uncredentialed custom endpoint as configured', async () => {
      const { providerVault } = await import('@/lib/sidedoor/providers/provider-credentials');
      const { prisma } = await import('@/lib/prisma');
      await providerVault(prisma).vault.configure('openai', { baseUrl: 'https://unconfigured.example/v1' });
      expect((await detectProviderReadiness()).openai).toBe('no_key');
    });

    it('probes the saved local endpoint used by inference', async () => {
      process.env.SELF_HOSTED = 'true';
      const { providerVault } = await import('@/lib/sidedoor/providers/provider-credentials');
      const { prisma } = await import('@/lib/prisma');
      await providerVault(prisma).vault.configure('ollama', { baseUrl: 'http://saved-ollama.example:11434/v1' });
      const requests: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => { requests.push(url); return Response.json({ models: [] }); });
      try {
        expect((await detectProviderReadiness()).ollama).toBe('ready');
        expect(requests).toContain('http://saved-ollama.example:11434/v1/models');
      } finally { vi.unstubAllGlobals(); }
    });
  });

  describe('resolveApiKey', () => {
    it('resolves the saved key', async () => {
      await configureProvider('openai', { apiKey: 'stored-key' });
      expect(await resolveApiKey('openai')).toBe('stored-key');
    });

    it('resolves the selected endpoint key from one credential snapshot', async () => {
      expect(await resolveApiKey('openai', { apiKey: 'official', baseUrl: 'https://custom.example/v1', compatibleApiKey: 'custom' })).toBe('custom');
      expect(await resolveApiKey('openai', { apiKey: 'official', baseUrl: 'https://custom.example/v1' })).toBe('');
      expect(await resolveApiKey('anthropic', { apiKey: 'anthropic-key' })).toBe('anthropic-key');
      expect(await resolveApiKey('google', { apiKey: 'google-key' })).toBe('google-key');
    });

    it('keeps keyless CLI and local configurations available', async () => {
      expect(await resolveApiKey('ollama', {})).toBe('');
      expect(await resolveApiKey('claude-code')).toBe('');
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
    });

    it('llamacpp provider exists with correct config', () => {
      const llamacpp = EXTRACTION_PROVIDERS.llamacpp!;
      expect(llamacpp.displayName).toBe('llama.cpp');
      expect(llamacpp.allowCustomBaseUrl).toBe(true);
      expect(llamacpp.defaultBaseUrl).toBe('http://localhost:8080/v1');
      expect(llamacpp.models).toHaveLength(0);
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
    });

    it('LOCAL_PROVIDERS includes ollama, llamacpp, and vllm', () => {
      expect(LOCAL_PROVIDERS.has('ollama')).toBe(true);
      expect(LOCAL_PROVIDERS.has('llamacpp')).toBe(true);
      expect(LOCAL_PROVIDERS.has('vllm')).toBe(true);
      expect(LOCAL_PROVIDERS.has('openai')).toBe(false);
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

  describe('isLocalProviderReachable', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns true when provider responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));
      expect(await isLocalProviderReachable('ollama')).toBe(true);
    });

    it('returns false when provider responds with non-200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
      expect(await isLocalProviderReachable('ollama')).toBe(false);
    });

    it('returns false when fetch throws (unreachable)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      expect(await isLocalProviderReachable('llamacpp')).toBe(false);
    });

    it('returns false for unknown providers', async () => {
      expect(await isLocalProviderReachable('nonexistent')).toBe(false);
    });

    it('probes the shared OpenAI-compatible readiness endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
      vi.stubGlobal('fetch', mockFetch);

      await isLocalProviderReachable('ollama');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.any(Object)
      );

      mockFetch.mockClear();
      await isLocalProviderReachable('vllm');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.any(Object)
      );
    });

    it('probes the canonically configured Ollama endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
      vi.stubGlobal('fetch', mockFetch);
      await configureProvider('ollama', {
        baseUrl: 'http://host.docker.internal:11434/v1',
        allowAnonymous: true,
      });
      await isLocalProviderReachable('ollama');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://host.docker.internal:11434/v1/models',
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
