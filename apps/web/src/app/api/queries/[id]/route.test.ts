import type { createRequestAccessFixture } from '@/test/access-fixture';
const sessionBoundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createRequestAccessFixture> | null }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createRequestAccessFixture } = await import('@/test/access-fixture');
  const fixture = createRequestAccessFixture(); sessionBoundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => sessionBoundary.fixture?.token ? { value: sessionBoundary.fixture.token } : undefined }) }));
beforeEach(() => sessionBoundary.fixture!.resetRequest());
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQueryFindUnique = vi.fn();
const mockQueryDelete = vi.fn();
const mockQueryDeleteMany = vi.fn();
const mockQueryFindMany = vi.fn();
const mockQueryUpdateMany = vi.fn();
const mockQueryUpdate = vi.fn();
const mockQueryEditEventCreateMany = vi.fn();

interface MockTransactionClient {
  query: {
    updateMany: (...args: unknown[]) => unknown;
    update: (...args: unknown[]) => unknown;
  };
  queryEditEvent: {
    createMany: (...args: unknown[]) => unknown;
  };
}

const mockTransaction = vi.fn((callback: (tx: MockTransactionClient) => unknown) => callback({
  query: {
    updateMany: (...args: unknown[]) => mockQueryUpdateMany(...args),
    update: (...args: unknown[]) => mockQueryUpdate(...args),
  },
  queryEditEvent: {
    createMany: (...args: unknown[]) => mockQueryEditEventCreateMany(...args),
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: async () => sessionBoundary.fixture!.user },
    $transaction: (callback: (tx: MockTransactionClient) => unknown) => mockTransaction(callback),
    query: {
      findUnique: (...args: unknown[]) => mockQueryFindUnique(...args),
      delete: (...args: unknown[]) => mockQueryDelete(...args),
      deleteMany: (...args: unknown[]) => mockQueryDeleteMany(...args),
      findMany: (...args: unknown[]) => mockQueryFindMany(...args),
      updateMany: (...args: unknown[]) => mockQueryUpdateMany(...args),
      update: (...args: unknown[]) => mockQueryUpdate(...args),
    },
    extractionConfig: { findUnique: async () => null },
    queryEditEvent: {
      createMany: (...args: unknown[]) => mockQueryEditEventCreateMany(...args),
    },
  },
}));

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));


// After authorizeMutation moved to @/lib/query-auth, every hosted mode path
// calls getSessionToken() -> cookies() from next/headers. Without this mock
// jsdom-less Vitest blows up the moment authorizeMutation is invoked.

import { DELETE, PATCH } from './route';

function makeDeleteRequest(id: string, body?: Record<string, unknown>): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/queries/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe('DELETE /api/queries/[id]', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueryDelete.mockResolvedValue({});
    mockQueryDeleteMany.mockResolvedValue({ count: 0 });
    mockIsMultiUserEnabled.mockResolvedValue(false);
    await sessionBoundary.fixture!.signIn(null);
    delete process.env.SELF_HOSTED;
  });

  afterEach(() => {
    delete process.env.SELF_HOSTED;
  });

  it('returns 404 when query does not exist', async () => {
    mockQueryFindUnique.mockResolvedValue(null);
    const res = await DELETE(...makeDeleteRequest('missing', { deleteToken: 'tok' }));
    const data = await res.json();
    expect(res.status).toBe(404);
    expect(data.error).toContain('not found');
  });

  it('returns 401 when token is missing (hosted)', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    const res = await DELETE(...makeDeleteRequest('q1', {}));
    const data = await res.json();
    expect(res.status).toBe(401);
    expect(data.error).toContain('token');
  });

  it('returns 403 when token is wrong (hosted)', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'wrong' }));
    const data = await res.json();
    expect(res.status).toBe(403);
    expect(data.error).toContain('Invalid');
  });

  it('deletes with valid token (hosted)', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.deleted).toBe(true);
    expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
  });

  it('deletes without a tracker token for a signed-in solo owner', async () => {
    process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    const res = await DELETE(...makeDeleteRequest('q1', {}));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.deleted).toBe(true);
    expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
  });

  it('deletes with a null tracker token for a signed-in solo owner', async () => {
    process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockQueryFindUnique.mockResolvedValue({ deleteToken: null });
    const res = await DELETE(...makeDeleteRequest('q1'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.deleted).toBe(true);
  });

  it('deletes with valid token when SELF_HOSTED=true', async () => {
    process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.deleted).toBe(true);
    expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
  });

  it('still requires token when SELF_HOSTED is not set', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    const res = await DELETE(...makeDeleteRequest('q1', {}));
    expect(res.status).toBe(401);
  });

  it('hosted mode: persisted owner session cookie authorizes without a token', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });
    await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    const res = await DELETE(...makeDeleteRequest('q1', {}));
    expect(res.status).toBe(200);
    expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
  });

  it('hosted mode: invalid admin session falls through to token check', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token' });


    const res = await DELETE(...makeDeleteRequest('q1', {}));
    expect(res.status).toBe(401);
    expect(mockQueryDelete).not.toHaveBeenCalled();
  });

  describe('self hosted multi user mode', () => {
    beforeEach(async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockIsMultiUserEnabled.mockResolvedValue(true);
    });

    it('lets admin delete any query without token', async () => {
      await sessionBoundary.fixture!.signIn({ id: 'admin_1', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', userId: 'someone_else' });
      const res = await DELETE(...makeDeleteRequest('q1'));
      expect(res.status).toBe(200);
      expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
    });

    it('lets the owner delete via user session', async () => {
      await sessionBoundary.fixture!.signIn({ id: 'user_1', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', userId: 'user_1' });
      const res = await DELETE(...makeDeleteRequest('q1'));
      expect(res.status).toBe(200);
    });

    it('rejects a non owner non admin user with 403', async () => {
      await sessionBoundary.fixture!.signIn({ id: 'user_2', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', userId: 'user_1' });
      const res = await DELETE(...makeDeleteRequest('q1'));
      expect(res.status).toBe(403);
      expect(mockQueryDelete).not.toHaveBeenCalled();
    });

    it('still accepts a matching deleteToken even without a session', async () => {
      await sessionBoundary.fixture!.signIn(null);
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', userId: 'user_1' });
      const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'real-token' }));
      expect(res.status).toBe(200);
    });

    it('rejects an unowned query (userId null) from a non admin user', async () => {
      await sessionBoundary.fixture!.signIn({ id: 'user_2', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, userId: null });
      const res = await DELETE(...makeDeleteRequest('q1'));
      expect(res.status).toBe(403);
    });
  });

  describe('groupDelete', () => {
    it('deletes all siblings via deleteMany when groupDelete=true (hosted)', async () => {
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: 'g1', userId: null });
      mockQueryDeleteMany.mockResolvedValue({ count: 3 });
      const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'real-token', groupDelete: true }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toEqual({ deleted: true, groupDeleted: true, count: 3 });
      expect(mockQueryDeleteMany).toHaveBeenCalledWith({ where: { groupId: 'g1' } });
      expect(mockQueryDelete).not.toHaveBeenCalled();
    });

    it('rejects groupDelete with wrong token (hosted, no deleteMany call)', async () => {
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: 'g1', userId: null });
      const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'wrong', groupDelete: true }));
      expect(res.status).toBe(403);
      expect(mockQueryDeleteMany).not.toHaveBeenCalled();
      expect(mockQueryDelete).not.toHaveBeenCalled();
    });

    it('admin can groupDelete without token in multi user mode', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockIsMultiUserEnabled.mockResolvedValue(true);
      await sessionBoundary.fixture!.signIn({ id: 'admin_1', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: 'g1', userId: 'someone_else' });
      mockQueryDeleteMany.mockResolvedValue({ count: 2 });
      const res = await DELETE(...makeDeleteRequest('q1', { groupDelete: true }));
      expect(res.status).toBe(200);
      expect(mockQueryDeleteMany).toHaveBeenCalledWith({ where: { groupId: 'g1' } });
    });

    it('owner can groupDelete via user session in multi user mode', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockIsMultiUserEnabled.mockResolvedValue(true);
      await sessionBoundary.fixture!.signIn({ id: 'user_1', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: 'g1', userId: 'user_1' });
      mockQueryDeleteMany.mockResolvedValue({ count: 4 });
      const res = await DELETE(...makeDeleteRequest('q1', { groupDelete: true }));
      expect(res.status).toBe(200);
      expect(mockQueryDeleteMany).toHaveBeenCalledWith({ where: { groupId: 'g1' } });
    });

    it('falls back to single-row delete when groupId is null even if groupDelete=true', async () => {
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: null, userId: null });
      const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'real-token', groupDelete: true }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toEqual({ deleted: true, groupDeleted: false });
      expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
      expect(mockQueryDeleteMany).not.toHaveBeenCalled();
    });

    it('single-row delete still works when groupDelete omitted on a grouped row', async () => {
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: 'g1', userId: null });
      const res = await DELETE(...makeDeleteRequest('q1', { deleteToken: 'real-token' }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toEqual({ deleted: true, groupDeleted: false });
      expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
      expect(mockQueryDeleteMany).not.toHaveBeenCalled();
    });
  });
});

function makePatchRequest(id: string, body: Record<string, unknown>): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/queries/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe('PATCH /api/queries/[id]', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueryFindMany.mockResolvedValue([]);
    mockQueryUpdateMany.mockResolvedValue({ count: 1 });
    mockQueryEditEventCreateMany.mockResolvedValue({ count: 0 });
    mockIsMultiUserEnabled.mockResolvedValue(false);
    await sessionBoundary.fixture!.signIn(null);
    delete process.env.SELF_HOSTED;
  });

  afterEach(() => {
    delete process.env.SELF_HOSTED;
  });

  it('returns 401 when token is missing (hosted)', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: null });
    const res = await PATCH(...makePatchRequest('q1', { scrapeInterval: 6 }));
    expect(res.status).toBe(401);
  });

  it('updates interval with valid token (hosted)', async () => {
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: null });
    const res = await PATCH(...makePatchRequest('q1', { deleteToken: 'real-token', scrapeInterval: 6 }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.scrapeInterval).toBe(6);
  });

  it('updates interval without a tracker token for a signed-in solo owner', async () => {
    process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: null });
    const res = await PATCH(...makePatchRequest('q1', { scrapeInterval: 3 }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.scrapeInterval).toBe(3);
  });

  it('rejects invalid interval even when SELF_HOSTED=true', async () => {
    process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null });
    const res = await PATCH(...makePatchRequest('q1', { scrapeInterval: 99 }));
    expect(res.status).toBe(400);
  });

  it('rejects empty body (no updatable fields)', async () => {
    process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
    mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null });
    const res = await PATCH(...makePatchRequest('q1', {}));
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toContain('No updatable fields');
  });

  describe('active toggle', () => {
    it('updates active with valid token (hosted) and cascades by groupId', async () => {
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: 'g1', userId: null });
      mockQueryFindMany.mockResolvedValue([{ id: 'q2' }, { id: 'q3' }]);
      mockQueryUpdateMany.mockResolvedValue({ count: 3 });
      const res = await PATCH(...makePatchRequest('q1', { deleteToken: 'real-token', active: false }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({ active: false, updated: 3 });
      expect(mockQueryUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ['q1', 'q2', 'q3'] } },
        data: { active: false },
      });
    });

    it('updates active without cascade when groupId is null', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { active: true }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({ active: true, updated: 1 });
      expect(mockQueryUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ['q1'] } },
        data: { active: true },
      });
    });

    it('rejects non-boolean active', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { active: 'yes' }));
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.error).toContain('active');
    });

    it('updates both scrapeInterval and active in one call', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: 'g1', userId: null });
      mockQueryFindMany.mockResolvedValue([{ id: 'q2' }]);
      const res = await PATCH(...makePatchRequest('q1', { scrapeInterval: 3, active: true }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({ scrapeInterval: 3, active: true, updated: 2 });
      expect(mockQueryUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ['q1', 'q2'] } },
        data: { scrapeInterval: 3, active: true },
      });
    });

    it('rejects active toggle without token (hosted)', async () => {
      mockQueryFindUnique.mockResolvedValue({ deleteToken: 'real-token', groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { active: false }));
      expect(res.status).toBe(401);
      expect(mockQueryUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('tracker filters', () => {
    const editableQuery = {
      id: 'q1',
      deleteToken: null,
      groupId: 'g1',
      userId: null,
      maxPrice: null,
      maxStops: 1,
      maxDurationHours: null,
      preferredAirlines: [],
      timePreference: 'any',
      cabinClass: 'economy',
      preferredAggregators: [],
    };

    it('updates tracker filters across grouped queries and records owner edit events', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      await sessionBoundary.fixture!.signIn({ id: 'user_1', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue(editableQuery);
      mockQueryFindMany.mockResolvedValue([{
        ...editableQuery,
        id: 'q2',
        maxStops: null,
      }]);

      const res = await PATCH(...makePatchRequest('q1', {
        maxPrice: 500,
        maxStops: 0,
        maxDurationHours: 12,
        preferredAirlines: [' Delta ', ''],
      }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({
        maxPrice: 500,
        maxStops: 0,
        maxDurationHours: 12,
        preferredAirlines: ['Delta'],
        updated: 2,
      });
      expect(mockQueryUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ['q1', 'q2'] } },
        data: {
          maxPrice: 500,
          maxStops: 0,
          maxDurationHours: 12,
          preferredAirlines: ['Delta'],
        },
      });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockQueryEditEventCreateMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            queryId: 'q1',
            userId: 'user_1',
            summary: '4 tracker filters changed',
            changes: {
              changes: expect.arrayContaining([
                expect.objectContaining({
                  field: 'maxStops',
                  beforeLabel: 'Max 1 stop',
                  afterLabel: 'Nonstop only',
                }),
              ]),
            },
          }),
          expect.objectContaining({ queryId: 'q2' }),
        ]),
      });
    });

    it('rejects invalid maxStops before updating', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue(editableQuery);

      const res = await PATCH(...makePatchRequest('q1', { maxStops: 11 }));
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('maxStops');
      expect(mockQueryUpdateMany).not.toHaveBeenCalled();
      expect(mockQueryEditEventCreateMany).not.toHaveBeenCalled();
    });

    it('accepts a high denomination maxPrice above the old 1M cap', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      await sessionBoundary.fixture!.signIn({ id: 'user_1', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue(editableQuery);
      mockQueryFindMany.mockResolvedValue([]);

      const res = await PATCH(...makePatchRequest('q1', { maxPrice: 2_550_760 }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({ maxPrice: 2_550_760 });
    });

    it('rejects time and cabin edits because snapshots cannot enforce them', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue(editableQuery);

      const res = await PATCH(...makePatchRequest('q1', {
        timePreference: 'morning',
        cabinClass: 'business',
      }));
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('No updatable fields');
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockQueryUpdateMany).not.toHaveBeenCalled();
      expect(mockQueryEditEventCreateMany).not.toHaveBeenCalled();
    });
  });

  describe('label', () => {
    beforeEach(async () => {
      mockQueryUpdate.mockResolvedValue({});
    });

    it('updates label on the single id only (no group cascade)', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: 'g1', userId: null });
      const res = await PATCH(...makePatchRequest('q1', { label: 'Paris via Google' }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({ label: 'Paris via Google' });
      expect(mockQueryUpdate).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { label: 'Paris via Google' },
      });
      expect(mockQueryUpdateMany).not.toHaveBeenCalled();
    });

    it('clears label when set to null', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { label: null }));
      expect(res.status).toBe(200);
      expect(mockQueryUpdate).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { label: null },
      });
    });

    it('rejects label longer than 60 characters', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { label: 'a'.repeat(61) }));
      expect(res.status).toBe(400);
      expect(mockQueryUpdate).not.toHaveBeenCalled();
    });

    it('rejects non-string non-null label', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { label: 123 }));
      expect(res.status).toBe(400);
      expect(mockQueryUpdate).not.toHaveBeenCalled();
    });

    it('trims whitespace and stores null for empty string', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { label: '   ' }));
      expect(res.status).toBe(200);
      expect(mockQueryUpdate).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { label: null },
      });
    });
  });

  describe('preferredAggregators', () => {
    beforeEach(async () => {
      mockQueryUpdate.mockResolvedValue({});
    });

    it('updates preferredAggregators on the single id only (no group cascade)', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: 'g1', userId: null });
      const res = await PATCH(...makePatchRequest('q1', { preferredAggregators: ['skyscanner', 'google_flights'] }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.data).toMatchObject({ preferredAggregators: ['skyscanner', 'google_flights'] });
      expect(mockQueryUpdate).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { preferredAggregators: ['skyscanner', 'google_flights'] },
      });
      // No cascade for aggregator prefs even with a groupId
      expect(mockQueryUpdateMany).not.toHaveBeenCalled();
      expect(mockQueryFindMany).not.toHaveBeenCalled();
    });

    it('rejects unknown aggregator with 422', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { preferredAggregators: ['google_flights', 'expedia'] }));
      expect(res.status).toBe(422);
      expect(mockQueryUpdate).not.toHaveBeenCalled();
    });

    it('rejects non-array preferredAggregators with 422', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { preferredAggregators: 'google_flights' }));
      expect(res.status).toBe(422);
    });

    it('accepts an empty array as clear', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: null, userId: null });
      const res = await PATCH(...makePatchRequest('q1', { preferredAggregators: [] }));
      expect(res.status).toBe(200);
      expect(mockQueryUpdate).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { preferredAggregators: [] },
      });
    });

    it('combines with cascaded fields: scrapeInterval cascades, preferredAggregators does not', async () => {
      process.env.SELF_HOSTED = 'true';
      await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue({ deleteToken: null, groupId: 'g1', userId: null });
      mockQueryFindMany.mockResolvedValue([{ id: 'q2' }]);
      const res = await PATCH(...makePatchRequest('q1', { scrapeInterval: 6, preferredAggregators: ['kayak'] }));
      expect(res.status).toBe(200);
      expect(mockQueryUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ['q1', 'q2'] } },
        data: { scrapeInterval: 6 },
      });
      expect(mockQueryUpdate).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { preferredAggregators: ['kayak'] },
      });
    });
  });
});
