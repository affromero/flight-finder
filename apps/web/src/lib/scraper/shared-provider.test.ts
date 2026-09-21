import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findFirst: async () => null } } }));
const { EXTRACTION_PROVIDERS } = await import('./ai-registry');

function response() {
  return Response.json({ id: 'completion', created: 1, model: 'selected-model', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('shared extraction providers', () => {
  it('uses the canonical Anthropic endpoint and ignores the live environment', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ignored-live-environment.example');
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://canonical.example/v1/messages');
      expect(new Headers(init.headers).get('x-api-key')).toBe('anthropic-key');
      expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 8192 });
      return Response.json({ id: 'message', type: 'message', role: 'assistant', model: 'model', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } });
    });
    expect((await EXTRACTION_PROVIDERS.anthropic!.extract('anthropic-key', 'model', 'system', 'user', { baseUrl: 'https://canonical.example' })).content).toBe('{}');
  });

  it('ignores stale local configuration for Google and preserves its model output default', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toContain('https://generativelanguage.googleapis.com/v1beta/models/model:generateContent');
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe('google-key');
      const body = JSON.parse(String(init.body));
      expect(body.generationConfig ?? {}).not.toHaveProperty('maxOutputTokens');
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } });
    });
    expect(await EXTRACTION_PROVIDERS.google!.extract('google-key', 'model', 'system', 'user', { baseUrl: 'http://stale-local:11434' })).toMatchObject({ content: '{}', usage: { inputTokens: 5, outputTokens: 2 } });
  });

  it('preserves unknown provider usage instead of recording zero tokens', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }));
    expect(await EXTRACTION_PROVIDERS.google!.extract('google-key', 'model', 'system', 'user')).toMatchObject({ content: '{}', usage: { inputTokens: null, outputTokens: null } });
  });

  it('rejects truncated extraction even when its partial result resembles valid JSON', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ id: 'completion', created: 1, model: 'model', choices: [{ index: 0, message: { content: '{}' }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    await expect(EXTRACTION_PROVIDERS.openai!.extract('key', 'model', 'system', 'user')).rejects.toMatchObject({ reason: 'length', usage: expect.objectContaining({ inputTokens: 20, outputTokens: 10 }) });
  });
  it.each([
    ['ollama', 'http://host.docker.internal:11434', 'http://host.docker.internal:11434/v1/chat/completions'],
    ['llamacpp', 'http://localhost:8080/', 'http://localhost:8080/v1/chat/completions'],
    ['vllm', 'http://localhost:8000/v1', 'http://localhost:8000/v1/chat/completions'],
  ])('keeps %s endpoint normalization, structured output and measured usage', async (provider, baseUrl, expectedUrl) => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toBe(expectedUrl);
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'selected-model', response_format: { type: 'json_object' }, max_tokens: 8192 });
      expect(JSON.parse(String(init.body))).not.toHaveProperty('stream_options');
      return response();
    });
    expect(await EXTRACTION_PROVIDERS[provider!]!.extract('', 'selected-model', 'system', 'user', { baseUrl, responseFormat: 'json_object' })).toEqual({ content: '{}', usage: { inputTokens: 5, outputTokens: 2 } });
  });

  it('uses the local default when canonical configuration has no endpoint', async () => {
    vi.stubEnv('OLLAMA_HOST', 'http://ignored-live-environment:11434');
    vi.stubGlobal('fetch', async (url: string) => { expect(String(url)).toBe('http://localhost:11434/v1/chat/completions'); return response(); });
    expect((await EXTRACTION_PROVIDERS.ollama!.extract('', 'model', 'system', 'user')).content).toBe('{}');
  });

  it('preserves an explicitly configured OpenAI-compatible endpoint and its resolved key', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://private.example/api/chat/completions');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer saved-key');
      expect(JSON.parse(String(init.body))).not.toHaveProperty('response_format');
      return response();
    });
    await EXTRACTION_PROVIDERS.openai!.extract('saved-key', 'model', 'system', 'user', { baseUrl: 'https://private.example/api' });
  });

  it.each(['openai', 'ollama', 'llamacpp', 'vllm'])('cancels %s when the configured deadline expires', async provider => {
    let cancelled = false;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toContain('/chat/completions');
      await new Promise<void>(resolve => { if (init.signal?.aborted) resolve(); else init.signal?.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }); });
      init.signal?.throwIfAborted();
      return response();
    });
    await expect(EXTRACTION_PROVIDERS[provider]!.extract('key', 'model', 'system', 'user', { timeoutMs: 30 })).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
