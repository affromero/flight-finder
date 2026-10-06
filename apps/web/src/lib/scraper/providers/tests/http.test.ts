import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXTRACTION_PROVIDERS } from '../../ai-registry';

vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findFirst: async () => null } } }));

describe('canonical OpenAI-compatible HTTP transport', () => {
  let server: Server;
  let baseUrl: string;
  let held = false;
  let received: ((response: ServerResponse) => void) | undefined;
  let body: Record<string, unknown>;
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let bytes = ''; for await (const chunk of request) bytes += String(chunk);
      body = JSON.parse(bytes) as Record<string, unknown>;
      received?.(response);
      if (held) return;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'fixture', created: 1, model: 'qwen3:8b', choices: [{ index: 0, message: { role: 'assistant', content: '{"flights":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing SDK fixture');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

  it.each(['openai', 'ollama', 'llamacpp', 'vllm'])('preserves %s output, measured usage and configured reasoning defaults', async provider => {
    held = false;
    const result = await EXTRACTION_PROVIDERS[provider]!.extract('fixture-key', 'qwen3:8b', 'system', 'user', { baseUrl, responseFormat: 'json_object', timeoutMs: 2000 });
    expect(result).toEqual({ content: '{"flights":[]}', usage: { inputTokens: 12, outputTokens: 8 } });
    expect(body).toMatchObject({ model: 'qwen3:8b', response_format: { type: 'json_object' } });
    expect(body).not.toHaveProperty('think');
    expect(body).not.toHaveProperty('reasoning_effort');
  });
  it.each(['openai', 'ollama', 'llamacpp', 'vllm'])('bounds a stalled %s HTTP response with the configured deadline', async provider => {
    held = true;
    let pending: ServerResponse | undefined;
    received = response => { pending = response; };
    try {
      await expect(EXTRACTION_PROVIDERS[provider]!.extract('fixture-key', 'qwen3:8b', 'system', 'user', { baseUrl, timeoutMs: 150 })).rejects.toThrow();
      expect(pending).toBeDefined();
    } finally { pending?.destroy(); received = undefined; held = false; }
  });
  it.each(['openai', 'ollama', 'llamacpp', 'vllm'])('cancels an acknowledged %s HTTP request before its longer deadline', async provider => {
    held = true;
    const controller = new AbortController();
    let pending: ServerResponse | undefined;
    received = response => { pending = response; controller.abort(new Error('Fixture cancelled')); };
    try {
      await expect(EXTRACTION_PROVIDERS[provider]!.extract('fixture-key', 'qwen3:8b', 'system', 'user', { baseUrl, timeoutMs: 5000, signal: controller.signal })).rejects.toThrow();
      expect(pending).toBeDefined();
      expect(controller.signal.aborted).toBe(true);
    } finally { pending?.destroy(); received = undefined; held = false; }
  });
});
