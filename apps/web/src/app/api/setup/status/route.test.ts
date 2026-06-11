import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();
const mockDetect = vi.fn(async () => ['anthropic', 'ollama']);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));

vi.mock('@/lib/scraper/ai-registry', () => ({
  detectAvailableProviders: () => mockDetect(),
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
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: 'ollama', adminPasswordHash: 'self-hosted' });
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

  // The setup wizard is unauthenticated by necessity (no admin exists yet) and
  // needs provider detection to render its picker. The rich shape is exposed
  // ONLY while setup is incomplete, then disappears once configured.
  it('exposes detected providers and mode during a self-hosted first-run', async () => {
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: null });
    const res = await GET();
    const body = await res.json();
    expect(body.isSelfHosted).toBe(true);
    expect(body.detectedProviders).toEqual(['anthropic', 'ollama']);
    expect(body.currentProvider).toBeNull();
  });

  it('exposes detected providers during a hosted first-run (no admin password yet)', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(body.isSelfHosted).toBe(false);
    expect(Array.isArray(body.detectedProviders)).toBe(true);
  });

  it('stops exposing provider detection once setup is complete (self-hosted)', async () => {
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: 'ollama', adminPasswordHash: 'self-hosted' });
    const res = await GET();
    const body = await res.json();
    expect(body).not.toHaveProperty('detectedProviders');
    expect(body).not.toHaveProperty('isSelfHosted');
    expect(mockDetect).not.toHaveBeenCalled();
  });
});
