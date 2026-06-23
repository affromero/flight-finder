import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockUpsert = vi.fn();
const mockFindFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));

vi.mock('@/lib/community-sync', () => ({
  registerForCommunity: vi.fn().mockResolvedValue('comm_key'),
}));

import { POST } from './route';

function setupRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3003/api/setup', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/setup — provider API key (#149)', () => {
  const savedSelfHosted = process.env.SELF_HOSTED;

  beforeEach(() => {
    vi.clearAllMocks();
    // Self-hosted so no admin password is required; isolates the key behavior.
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue(null); // setup not yet completed
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  afterEach(() => {
    if (savedSelfHosted === undefined) delete process.env.SELF_HOSTED;
    else process.env.SELF_HOSTED = savedSelfHosted;
  });

  it('stores an entered key encrypted in the matching column (both upsert branches)', async () => {
    const { decryptSecret } = await import('@/lib/secret-crypto');
    const res = await POST(setupRequest({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-secret-123' }));
    expect(res.status).toBe(200);

    const args = mockUpsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.create.openaiApiKey).toEqual(expect.any(String));
    expect(args.create.openaiApiKey).not.toBe('sk-secret-123'); // never plaintext
    expect(decryptSecret(args.create.openaiApiKey as string)).toBe('sk-secret-123');
    expect(decryptSecret(args.update.openaiApiKey as string)).toBe('sk-secret-123');
  });

  it('omits the key column entirely when no apiKey is provided', async () => {
    const res = await POST(setupRequest({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }));
    expect(res.status).toBe(200);
    const args = mockUpsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(args.create).not.toHaveProperty('anthropicApiKey');
    expect(args.create).not.toHaveProperty('openaiApiKey');
  });

  it('ignores an API key for a provider with no key column (local/CLI)', async () => {
    const res = await POST(setupRequest({ provider: 'ollama', model: 'llama3', apiKey: 'should-be-ignored' }));
    expect(res.status).toBe(200);
    const args = mockUpsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(JSON.stringify(args.create)).not.toContain('should-be-ignored');
  });
});
