import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.fn();
const mockFindFirst = vi.fn().mockResolvedValue(null);
const mockReachable = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));

vi.mock('@/lib/admin-guard', () => ({
  requireAdminApi: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/cron', () => ({
  updateCronInterval: vi.fn(),
}));

vi.mock('@/lib/scraper/ai-registry', () => ({
  EXTRACTION_PROVIDERS: {
    anthropic: { displayName: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', allowCustomModel: true, models: [] },
    openai: { displayName: 'OpenAI', envKey: 'OPENAI_API_KEY', allowCustomModel: true, allowCustomBaseUrl: true, models: [] },
    google: { displayName: 'Google', envKey: 'GOOGLE_AI_API_KEY', allowCustomModel: true, models: [] },
    ollama: { displayName: 'Ollama', allowCustomModel: true, models: [] },
  },
  LOCAL_PROVIDERS: new Set(['ollama', 'llamacpp', 'vllm']),
  isLocalProviderReachable: (...args: unknown[]) => mockReachable(...args),
}));

import { GET, PATCH } from './route';
import { NextRequest } from 'next/server';

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3003/api/admin/config', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
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

describe('PATCH /api/admin/config: admin password (AUTH-3, AUTH-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('rejects a password shorter than 8 characters with 400', async () => {
    const res = await PATCH(patchRequest({ adminPassword: 'short' }));
    expect(res.status).toBe(400);
    // Nothing must be written when the password is rejected.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('accepts an 8+ character password and revokes existing sessions', async () => {
    const before = Date.now();
    const res = await PATCH(patchRequest({ adminPassword: 'longenough123' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    // The password is stored hashed, never in plaintext.
    expect(data.update.adminPasswordHash).toEqual(expect.any(String));
    expect(data.update.adminPasswordHash).not.toBe('longenough123');
    // A revocation cutoff is stamped so older admin tokens are invalidated.
    const validFrom = data.update.adminSessionsValidFrom as Date;
    expect(validFrom).toBeInstanceOf(Date);
    expect(validFrom.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not stamp adminSessionsValidFrom when no password is set', async () => {
    await PATCH(patchRequest({ extractTimeoutSeconds: 120 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('adminSessionsValidFrom');
  });
});

describe('GET /api/admin/config: secret redaction (CRYPTO-5/COMM-8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not return the community API key in plaintext', async () => {
    const realKey = 'comm_live_abcdefghijklmnopqrstuvwxyz1234';
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      communityApiKey: realKey,
      adminPasswordHash: 'hash',
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

  it('does not leak the admin password hash', async () => {
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      adminPasswordHash: 'super-secret-hash',
      communityApiKey: null,
    });

    const res = await GET();
    const json = (await res.json()) as {
      data: { adminPasswordHash?: string; hasAdminPassword: boolean; communityApiKey: string | null };
    };
    expect(json.data.adminPasswordHash).toBeUndefined();
    expect(json.data.hasAdminPassword).toBe(true);
    expect(json.data.communityApiKey).toBeNull();
  });

  it('exposes hasXKey booleans but never the stored provider key (#149)', async () => {
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      openaiApiKey: 'iv:tag:ciphertext',
      anthropicApiKey: null,
      googleApiKey: null,
      communityApiKey: null,
    });

    const res = await GET();
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.hasOpenaiKey).toBe(true);
    expect(json.data.hasAnthropicKey).toBe(false);
    expect(json.data.hasGoogleKey).toBe(false);
    // The ciphertext (masked or not) must never cross the wire.
    expect(json.data).not.toHaveProperty('openaiApiKey');
    expect(JSON.stringify(json.data)).not.toContain('iv:tag:ciphertext');
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

  it('rejects selecting an env-backed provider with no usable key, without writing', async () => {
    const orig = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY; // no env key, no stored key, no local endpoint
    try {
      const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash' }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = orig;
    }
  });

  it('accepts the same provider when an API key is entered, and stores it encrypted', async () => {
    const { decryptSecret } = await import('@/lib/secret-crypto');
    const orig = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'g-secret-123' }));
      expect(res.status).toBe(200);
      const update = (mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update;
      expect(update.googleApiKey).toEqual(expect.any(String));
      expect(update.googleApiKey).not.toBe('g-secret-123');
      expect(decryptSecret(update.googleApiKey as string)).toBe('g-secret-123');
    } finally {
      if (orig === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = orig;
    }
  });

  it('accepts switching to a provider that already has a decryptable stored key (no re-entry)', async () => {
    const { encryptSecret } = await import('@/lib/secret-crypto');
    const orig = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    mockFindFirst.mockResolvedValue({ googleApiKey: encryptSecret('already-stored-key') });
    try {
      const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash' }));
      expect(res.status).toBe(200);
    } finally {
      if (orig === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = orig;
    }
  });

  it('rejects a provider whose stored key cannot be decrypted and has no env key (Codex audit #2)', async () => {
    const orig = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    // Column present but not valid ciphertext (eg. ADMIN_SESSION_SECRET rotated):
    // runtime would fall through to the absent env key, so the guard must reject.
    mockFindFirst.mockResolvedValue({ googleApiKey: 'not-decryptable-garbage' });
    try {
      const res = await PATCH(patchRequest({ provider: 'google', model: 'gemini-2.5-flash' }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = orig;
    }
  });

  it('clears a stored key when apiKey is null', async () => {
    // env key present so clearing the stored key does not trip the keyless guard
    const res = await PATCH(patchRequest({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: null }));
    expect(res.status).toBe(200);
    const update = (mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update;
    expect(update.anthropicApiKey).toBeNull();
  });

  it('lets a local provider save without any API key', async () => {
    const res = await PATCH(patchRequest({ provider: 'ollama', model: 'llama3' }));
    expect(res.status).toBe(200);
    const update = (mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update;
    expect(update.provider).toBe('ollama');
  });

  // Recurrence net: every env-backed provider must round-trip a GUI-entered key
  // (writable -> encrypted at rest -> exposed only as a boolean). A new provider
  // wired up incompletely fails here.
  describe.each([
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', column: 'anthropicApiKey', has: 'hasAnthropicKey' },
    { provider: 'openai', model: 'gpt-4.1-mini', column: 'openaiApiKey', has: 'hasOpenaiKey' },
    { provider: 'google', model: 'gemini-2.5-flash', column: 'googleApiKey', has: 'hasGoogleKey' },
  ])('contract: $provider', ({ provider, model, column, has }) => {
    it('persists an entered key encrypted and exposes only a boolean', async () => {
      const { decryptSecret } = await import('@/lib/secret-crypto');
      const secret = `secret-for-${provider}`;
      const res = await PATCH(patchRequest({ provider, model, apiKey: secret }));
      expect(res.status).toBe(200);
      const update = (mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update;
      expect(decryptSecret(update[column] as string)).toBe(secret);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data[has]).toBe(true);
      expect(json.data).not.toHaveProperty(column);
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

  it('does not probe reachability for an env-backed provider', async () => {
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
