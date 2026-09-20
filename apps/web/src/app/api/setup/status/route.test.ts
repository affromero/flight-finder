import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { createRequestAccessFixture } from '@/test/access-fixture';
import type { createStateBoundary } from '@/test/state-fixture';
const persistence = vi.hoisted(() => ({ state: null as ReturnType<typeof createStateBoundary> | null }));
vi.mock('@/lib/sidedoor/store', async () => {
  const { createStateBoundary } = await import('@/test/state-fixture');
  persistence.state = createStateBoundary();
  return { sharedStateStore: <State>(id: string, parse: (value: unknown) => State, initial: () => State) => id === 'access' ? sessionBoundary.fixture!.access.store : persistence.state!.store(id, parse, initial) };
});
const sessionBoundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createRequestAccessFixture> | null }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createRequestAccessFixture } = await import('@/test/access-fixture');
  const fixture = createRequestAccessFixture(); sessionBoundary.fixture = fixture;
  const { FlightFinderAccessStore } = await import('@/lib/sidedoor/access-store');
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, sharedAccessStore: new FlightFinderAccessStore(), SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => sessionBoundary.fixture?.token ? { value: sessionBoundary.fixture.token } : undefined }) }));

const mockFindFirst = vi.fn();
const mockDetect = vi.fn(async () => ['anthropic', 'ollama']);

vi.mock('@/lib/prisma', () => {
  const database = {
    sidedoorState: { findUnique: async () => {
      await sessionBoundary.fixture!.access.store.transact(state => {
        state.initializations = ['flight-finder-access-v2'];
        for (const principal of state.principals) principal.sourceVersion = '';
      });
      return { state: await sessionBoundary.fixture!.access.store.read() };
    } },
    user: { findMany: async () => sessionBoundary.fixture!.user ? [{ id: 'owner', username: 'owner', isAdmin: true, createdAt: new Date() }] : [] },
    extractionConfig: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      findUnique: (...args: unknown[]) => mockFindFirst(...args),
    },
  };
  return { prisma: { ...database, $transaction: async (operation: (value: typeof database) => Promise<unknown>) => operation(database) } };
});

vi.mock('@/lib/scraper/ai-registry', () => ({
  detectAvailableProviders: () => mockDetect(),
}));

import { GET } from './route';

describe('GET /api/setup/status -- information disclosure', () => {
  beforeEach(async () => {
    sessionBoundary.fixture!.resetRequest();
    persistence.state!.reset();
    mockFindFirst.mockResolvedValue(null);
    await (await import('@/lib/sidedoor/provider-credentials')).initializeProviderCredentials();
    vi.clearAllMocks();
    delete process.env.SELF_HOSTED;
  });

  it('does not reveal provider names to unauthenticated callers', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'singleton',
      provider: 'anthropic',
      setupComplete: true,
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
      setupComplete: true,
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
    mockFindFirst.mockResolvedValue({ id: 'singleton', setupComplete: true });
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
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: 'ollama', setupComplete: true });
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

  it('exposes detected providers and mode to the claimed owner during a self-hosted first-run', async () => {
    await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: null });
    const res = await GET();
    const body = await res.json();
    expect(body.isSelfHosted).toBe(true);
    expect(body.detectedProviders).toEqual(['anthropic', 'ollama']);
    expect(body.currentProvider).toBeNull();
  });

  it('exposes detected providers to the claimed owner during a hosted first-run', async () => {
    await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockFindFirst.mockResolvedValue(null);
    const res = await GET();
    const body = await res.json();
    expect(body.isSelfHosted).toBe(false);
    expect(Array.isArray(body.detectedProviders)).toBe(true);
  });

  it('stops exposing provider detection once setup is complete (self-hosted)', async () => {
    process.env.SELF_HOSTED = 'true';
    mockFindFirst.mockResolvedValue({ id: 'singleton', provider: 'ollama', setupComplete: true });
    const res = await GET();
    const body = await res.json();
    expect(body).not.toHaveProperty('detectedProviders');
    expect(body).not.toHaveProperty('isSelfHosted');
    expect(mockDetect).not.toHaveBeenCalled();
  });
});
