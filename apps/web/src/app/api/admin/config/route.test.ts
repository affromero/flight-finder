import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { createRequestAccessFixture } from '@/test/access-fixture';
import type { createStateBoundary } from '@/test/state-fixture';
const persistence = vi.hoisted(() => ({ state: null as ReturnType<typeof createStateBoundary> | null, config: null as Record<string, unknown> | null }));
vi.mock('@/lib/sidedoor/access/store', async () => {
  const { createStateBoundary } = await import('@/test/state-fixture');
  persistence.state = createStateBoundary();
  return { sharedStateStore: <State>(id: string, parse: (value: unknown) => State, initial: () => State) => id === 'access' ? sessionBoundary.fixture!.access.store : persistence.state!.store(id, parse, initial) };
});
const sessionBoundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createRequestAccessFixture> | null }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createRequestAccessFixture } = await import('@/test/access-fixture');
  const fixture = createRequestAccessFixture(); sessionBoundary.fixture = fixture;
  const { FlightFinderAccessStore } = await import('@/lib/sidedoor/access/access-store');
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, sharedAccessStore: new FlightFinderAccessStore(), SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => sessionBoundary.fixture?.token ? { value: sessionBoundary.fixture.token } : undefined }) }));
beforeEach(async () => {
  sessionBoundary.fixture!.resetRequest();
  await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
  persistence.state!.reset();
  persistence.config = null;
  await initializeProviderCredentials();
  await sessionBoundary.fixture!.access.store.transact(state => {
    state.initializations.push('flight-finder-platform-v1');
    state.principals[0]!.sourceVersion = '';
  });
});

const mockUpsert = vi.fn();
const mockFindFirst = vi.fn().mockResolvedValue(null);
const mockReachable = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/prisma', () => {
  const database = {
    sidedoorState: { findUnique: async () => ({ state: await sessionBoundary.fixture!.access.store.read() }) },
    user: {
      findUnique: async () => sessionBoundary.fixture!.user,
      findMany: async () => [{ id: 'owner', username: 'owner', isAdmin: true, createdAt: new Date() }],
    },
    extractionConfig: {
      async upsert(...args: unknown[]) { const result = await mockUpsert(...args); persistence.config = { ...persistence.config, ...result, updatedAt: new Date(), providerRevision: 1 }; return persistence.config; },
      async findFirst(...args: unknown[]) { const result = await mockFindFirst(...args); persistence.config = result ? { updatedAt: new Date(0), providerRevision: 0, ...result } : null; return persistence.config; },
      findUnique: async () => persistence.config,
      findUniqueOrThrow: async () => persistence.config,
      async update({ data }: { data: Record<string, unknown> }) { persistence.config = { ...persistence.config, ...data }; return persistence.config; },
    },
  };
  return { prisma: { ...database, $transaction: async (operation: (value: typeof database) => Promise<unknown>) => operation(database) } };
});

vi.mock('@/lib/cron', () => ({
  updateCronInterval: vi.fn(),
}));

vi.mock('@/lib/scraper/ai-registry', () => ({
  EXTRACTION_PROVIDERS: {
    anthropic: { displayName: 'Anthropic', allowCustomModel: true, models: [] },
    openai: { displayName: 'OpenAI', allowCustomModel: true, allowCustomBaseUrl: true, models: [] },
    google: { displayName: 'Google', allowCustomModel: true, models: [] },
    ollama: { displayName: 'Ollama', allowCustomModel: true, models: [] },
  },
  LOCAL_PROVIDERS: new Set(['ollama', 'llamacpp', 'vllm']),
  isLocalProviderReachable: (...args: unknown[]) => mockReachable(...args),
}));

import { GET, PATCH } from './route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { initializeProviderCredentials, providerVault } from '@/lib/sidedoor/providers/provider-credentials';

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3003/api/admin/config', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', host: 'localhost:3003', origin: 'http://localhost:3003', cookie: `ft-session=${sessionBoundary.fixture!.token}` },
  });
}

describe('PATCH /api/admin/config — extractTimeoutSeconds (issue #86)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton', extractTimeoutSeconds: 90 });
  });

  it('writes a valid number within range', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 240 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(240);
  });

  it('clamps a value below the 30s floor to 30', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 5 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(30);
  });

  it('clamps a value above the 600s ceiling to 600', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 9999 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(600);
  });

  it('rejects NaN from a cleared number input without crashing Prisma', async () => {
    // The admin UI sends `Number('')` which is NaN. `typeof NaN === 'number'`
    // is true, so without a Number.isFinite guard the NaN would have been
    // routed to Prisma which would 500 on the Int column write.
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: NaN }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('extractTimeoutSeconds');
  });

  it('rejects Infinity without crashing Prisma', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: Infinity }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('extractTimeoutSeconds');
  });

  it('skips the field when it is a string', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: '120' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('extractTimeoutSeconds');
  });

  it('rounds a fractional value to the nearest integer', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 47.6 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(48);
  });
});

describe('PATCH /api/admin/config — maxTrackedPerRoute (issue #89)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton', maxTrackedPerRoute: 10 });
  });

  it('writes a valid number within range', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 30 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(30);
  });

  it('clamps a value below the floor of 1 up to 1', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 0 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(1);
  });

  it('clamps a value above the ceiling of 50 down to 50', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 999 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(50);
  });

  it('rejects NaN from a cleared number input without crashing Prisma', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: NaN }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('maxTrackedPerRoute');
  });

  it('rounds a fractional value to the nearest integer', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 12.4 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(12);
  });
});

describe('PATCH /api/admin/config — notification settings (issue #106)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('clamps notifyMinDropPct into the 0..1 range', async () => {
    const res = await PATCH(patchRequest({ notifyMinDropPct: 5 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.notifyMinDropPct).toBe(1);
  });

  it('clamps a negative notifyMinDropAbs up to 0', async () => {
    await PATCH(patchRequest({ notifyMinDropAbs: -3 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.notifyMinDropAbs).toBe(0);
  });

  it('rejects an invalid publicBaseUrl', async () => {
    const res = await PATCH(patchRequest({ publicBaseUrl: 'not a url' }));
    expect(res.status).toBe(400);
  });

  it('accepts a valid publicBaseUrl', async () => {
    const res = await PATCH(patchRequest({ publicBaseUrl: 'https://flights.example.com' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.publicBaseUrl).toBe('https://flights.example.com');
  });

  it('stores null when publicBaseUrl is cleared', async () => {
    await PATCH(patchRequest({ publicBaseUrl: '' }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.publicBaseUrl).toBeNull();
  });

  it('accepts a valid family theme id as the instance default', async () => {
    const res = await PATCH(patchRequest({ theme: 'tron-light' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.theme).toBe('tron-light');
  });

  it('rejects a legacy flat theme id (must be family-mode now)', async () => {
    const res = await PATCH(patchRequest({ theme: 'basic-dark' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown theme id', async () => {
    const res = await PATCH(patchRequest({ theme: 'not-a-theme' }));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/admin/config — perf knobs (issue #106 gaps 2 & 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('clamps and rounds an out-of-range RPM override', async () => {
    await PATCH(patchRequest({ anthropicRpm: 99999.6 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.anthropicRpm).toBe(10000);
  });

  it('clears an RPM override when set to null', async () => {
    await PATCH(patchRequest({ googleRpm: null }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.googleRpm).toBeNull();
  });

  it('clamps previewConcurrency to the 10 ceiling (matching the env path)', async () => {
    await PATCH(patchRequest({ previewConcurrency: 999 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.previewConcurrency).toBe(10);
  });

  it('clamps previewAdmissionCap to the 50 ceiling', async () => {
    await PATCH(patchRequest({ previewAdmissionCap: 999 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.previewAdmissionCap).toBe(50);
  });

  it('ignores a non-numeric RPM value instead of writing NaN', async () => {
    await PATCH(patchRequest({ openaiRpm: 'fast' }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('openaiRpm');
  });
});

describe('PATCH /api/admin/config: shared password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('directs shared password changes to account security', async () => {
    const res = await PATCH(patchRequest({ adminPassword: 'short' }));
    expect(res.status).toBe(400);
    // Nothing must be written when the password is rejected.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

});

describe('GET /api/admin/config: secret redaction (CRYPTO-5/COMM-8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not return the community API key in plaintext', async () => {
    const realKey = 'comm_live_abcdefghijklmnopqrstuvwxyz1234';
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      communityApiKey: realKey,
      setupComplete: true,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { communityApiKey: string | null } };
    // The full secret must never cross the wire.
    expect(json.data.communityApiKey).not.toBe(realKey);
    expect(json.data.communityApiKey).not.toContain(realKey.slice(8, -4));
    // A masked fingerprint is still returned so the UI can render it.
    expect(json.data.communityApiKey).toContain('...');
  });

  it('exposes credential status without returning stored provider secrets', async () => {
    await providerVault(prisma).vault.configure('openai', { apiKey: 'saved-openai-key' });
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      communityApiKey: null,
    });

    const res = await GET();
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.hasOpenaiKey).toBe(true);
    expect(json.data.hasAnthropicKey).toBe(false);
    expect(json.data.hasGoogleKey).toBe(false);
    // The ciphertext (masked or not) must never cross the wire.
    expect(JSON.stringify(json.data)).not.toContain('saved-openai-key');
  });
});

describe('PATCH /api/admin/config — provider API keys (#149)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(null);
    mockUpsert.mockImplementation((args: { update: Record<string, unknown> }) =>
      Promise.resolve({ id: 'singleton', ...args.update }),
    );
  });

  it('rejects selecting a provider with no saved key, without writing', async () => {
    const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash' }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('accepts the same provider when an API key is entered, and stores it encrypted', async () => {
    const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'g-secret-123' }));
    expect(res.status).toBe(200);
    const { vault, store } = providerVault(prisma);
    expect(await vault.resolve('google')).toMatchObject({ apiKey: 'g-secret-123' });
    expect(JSON.stringify(await store.read())).not.toContain('g-secret-123');
  });

  it('accepts switching to a provider that already has a decryptable stored key (no re-entry)', async () => {
    await providerVault(prisma).vault.configure('google', { apiKey: 'already-stored-key' });
    const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash' }));
    expect(res.status).toBe(200);
  });

  it('rejects a provider whose saved key cannot be decrypted', async () => {
    const { vault, store } = providerVault(prisma);
    await store.transact(state => vault.quarantineState(state, 'google', { sourceFormat: 'test', sourceVersion: 1, payload: 'not-decryptable-garbage', failure: 'decryption_failed' }));
    const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash' }));
    expect(res.status).toBe(409);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('clears stored credentials through an explicit reset', async () => {
    mockFindFirst.mockResolvedValue({ provider: 'anthropic', providerRevision: 0 });
    await providerVault(prisma).vault.configure('anthropic', { apiKey: 'key-to-remove' });
    const res = await PATCH(patchRequest({ provider: 'anthropic', resetCredentials: true, expectedRevision: 0 }));
    expect(res.status).toBe(200);
    const { vault, store } = providerVault(prisma);
    expect((await vault.describe('anthropic')).fields.find(field => field.id === 'apiKey')?.source).toBe('unset');
    expect(JSON.stringify(await store.read())).not.toContain('key-to-remove');
  });

  it('lets a local provider save without any API key', async () => {
    const res = await PATCH(patchRequest({ provider: 'ollama', model: 'llama3' }));
    expect(res.status).toBe(200);
    const update = (mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update;
    expect(update.provider).toBe('ollama');
  });

  describe.each([
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', has: 'hasAnthropicKey' },
    { provider: 'openai', model: 'gpt-4.1-mini', has: 'hasOpenaiKey' },
    { provider: 'google', model: 'gemini-2.5-flash', has: 'hasGoogleKey' },
  ])('contract: $provider', ({ provider, model, has }) => {
    it('persists an entered key encrypted and exposes only a boolean', async () => {
      const secret = `secret-for-${provider}`;
      const res = await PATCH(patchRequest({ provider, model, apiKey: secret }));
      expect(res.status).toBe(200);
      const { vault, store } = providerVault(prisma);
      expect(await vault.resolve(provider)).toMatchObject({ apiKey: secret });
      expect(JSON.stringify(await store.read())).not.toContain(secret);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data[has]).toBe(true);
      expect(JSON.stringify(json.data)).not.toContain(secret);
    });
  });
});

describe('PATCH /api/admin/config — local provider reachability (#153)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReachable.mockResolvedValue(true);
    mockUpsert.mockImplementation((args: { update: Record<string, unknown> }) =>
      Promise.resolve({ id: 'singleton', ...args.update }),
    );
  });

  it('rejects an unreachable customBaseUrl for a local provider with 422 and no write', async () => {
    mockReachable.mockResolvedValueOnce(false);
    const res = await PATCH(patchRequest({ provider: 'ollama', model: 'llama3', customBaseUrl: 'http://localhost:9999/v1' }));
    expect(res.status).toBe(422);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('accepts a reachable customBaseUrl for a local provider and probes the given URL', async () => {
    const res = await PATCH(patchRequest({ provider: 'ollama', model: 'llama3', customBaseUrl: 'http://localhost:11434/v1' }));
    expect(res.status).toBe(200);
    expect(mockReachable).toHaveBeenCalledWith('ollama', 'http://localhost:11434/v1');
  });

  it('does not use the local reachability probe for a remote API provider', async () => {
    const res = await PATCH(patchRequest({ provider: 'openai', model: 'gpt-4.1-mini', customBaseUrl: 'http://localhost:1234/v1', apiKey: 'sk-x' }));
    expect(res.status).toBe(200);
    expect(mockReachable).not.toHaveBeenCalled();
  });

  it('does not probe when customBaseUrl is absent from the body', async () => {
    const res = await PATCH(patchRequest({ provider: 'ollama', model: 'llama3' }));
    expect(res.status).toBe(200);
    expect(mockReachable).not.toHaveBeenCalled();
  });

  it('does not re-probe when the customBaseUrl is unchanged from the stored value (Codex audit #4)', async () => {
    mockFindFirst.mockResolvedValue({ provider: 'ollama', customBaseUrl: 'http://localhost:11434/v1' });
    const res = await PATCH(patchRequest({ provider: 'ollama', model: 'llama3', customBaseUrl: 'http://localhost:11434/v1' }));
    expect(res.status).toBe(200);
    expect(mockReachable).not.toHaveBeenCalled();
  });
});
