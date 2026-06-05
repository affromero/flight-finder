import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));

import { GET } from './route';

describe('GET /api/setup/status -- information disclosure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SELF_HOSTED;
  });

  it('does not reveal provider names to unauthenticated callers', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'singleton',
      provider: 'anthropic',
      adminPasswordHash: 'hash',
    });
    const res = await GET();
    const body = await res.json();
    expect(body).not.toHaveProperty('detectedProviders');
    expect(body).not.toHaveProperty('currentProvider');
    expect(body).not.toHaveProperty('currentModel');
  });

  it('does not reveal API key presence to unauthenticated callers', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'singleton',
      provider: 'openai',
      adminPasswordHash: 'hash',
    });
    const res = await GET();
    const body = await res.json();
    // No field that indicates whether an API key is configured
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('openai');
    expect(bodyStr).not.toContain('anthropic');
    expect(bodyStr).not.toContain('provider');
  });

  it('returns setupComplete=true and needsSetup=false when admin password is set (hosted)', async () => {
    mockFindFirst.mockResolvedValue({ id: 'singleton', adminPasswordHash: 'hash' });
    const res = await GET();
    const body = await res.json();
    expect(body.setupComplete).toBe(true);
    expect(body.needsSetup).toBe(false);
  });

  it('returns setupComplete=false and needsSetup=true when no admin password is set (hosted)', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(body.setupComplete).toBe(false);
    expect(body.needsSetup).toBe(true);
  });

  it('returns setupComplete=true when SELF_HOSTED and provider is configured', async () => {
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: 'ollama' });
    const res = await GET();
    const body = await res.json();
    expect(body.setupComplete).toBe(true);
    expect(body.needsSetup).toBe(false);
  });

  it('returns setupComplete=false when SELF_HOSTED and no provider configured', async () => {
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: null });
    const res = await GET();
    const body = await res.json();
    expect(body.setupComplete).toBe(false);
    expect(body.needsSetup).toBe(true);
  });
});
