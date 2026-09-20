import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockUpsert = vi.fn();
const mockFindFirst = vi.fn();
import type { createStateBoundary } from '@/test/state-fixture';
const persistence = vi.hoisted(() => ({ state: null as ReturnType<typeof createStateBoundary> | null, config: null as Record<string, unknown> | null }));
vi.mock('@/lib/sidedoor/store', async () => {
  const { createStateBoundary } = await import('@/test/state-fixture');
  persistence.state = createStateBoundary();
  return { sharedStateStore: <State>(id: string, parse: (value: unknown) => State, initial: () => State) => id === 'access' ? sessionBoundary.fixture!.access.store : persistence.state!.store(id, parse, initial) };
});

vi.mock('@/lib/prisma', () => {
  const database = {
    sidedoorState: { findUnique: async () => ({ state: await sessionBoundary.fixture!.access.store.read() }) },
    user: {
      findUnique: async () => ({ id: 'owner', isAdmin: true }),
      findMany: async () => [{ id: 'owner', username: 'owner', isAdmin: true, createdAt: new Date() }],
    },
    extractionConfig: {
      async upsert(...args: unknown[]) { persistence.config = { ...await mockUpsert(...args), updatedAt: new Date(), providerRevision: 1 }; return persistence.config; },
      async findFirst(...args: unknown[]) { persistence.config = await mockFindFirst(...args); return persistence.config; },
      findUnique: async () => persistence.config,
      findUniqueOrThrow: async () => persistence.config,
    },
  };
  return { prisma: { ...database, $transaction: async (operation: (value: typeof database) => Promise<unknown>) => operation(database) } };
});

vi.mock('@/lib/community-sync', () => ({
  registerForCommunity: vi.fn().mockResolvedValue('comm_key'),
}));

import { POST } from './route';
import { prisma } from '@/lib/prisma';
import { providerVault } from '@/lib/sidedoor/provider-credentials';

function setupRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3003/api/setup', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', origin: 'http://localhost:3003', host: 'localhost:3003', cookie: `ft-session=${sessionBoundary.token}` },
  });
}

describe('POST /api/setup — provider API key (#149)', () => {
  const savedSelfHosted = process.env.SELF_HOSTED;

  beforeEach(async () => {
    sessionBoundary.fixture!.reset();
    sessionBoundary.token = await sessionBoundary.fixture!.issue('owner', true);
    persistence.state!.reset();
    persistence.config = null;
    await (await import('@/lib/sidedoor/provider-credentials')).initializeProviderCredentials();
    await sessionBoundary.fixture!.access.store.transact(state => { state.initializations.push('flight-finder-platform-v1'); state.principals[0]!.sourceVersion = ''; });
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

  it('stores an entered key encrypted in the shared vault', async () => {
    const res = await POST(setupRequest({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-secret-123' }));
    expect(res.status).toBe(200);

    const { vault, store } = providerVault(prisma);
    expect(await vault.resolve('openai')).toMatchObject({ apiKey: 'sk-secret-123' });
    expect(JSON.stringify(await store.read())).not.toContain('sk-secret-123');
  });

  it('rejects setup when the selected provider has no credential', async () => {
    const res = await POST(setupRequest({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects an undeclared credential instead of silently discarding it', async () => {
    const res = await POST(setupRequest({ provider: 'ollama', model: 'llama3', apiKey: 'should-be-ignored' }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
import type { createAccessFixture } from '@/test/access-fixture';
const sessionBoundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => sessionBoundary.token ? { value: sessionBoundary.token } : undefined }) }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); sessionBoundary.fixture = fixture;
  const { FlightFinderAccessStore } = await import('@/lib/sidedoor/access-store');
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, sharedAccessStore: new FlightFinderAccessStore(), SHARED_SESSION_COOKIE: 'ft-session' };
});
