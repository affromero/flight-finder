import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockIsMultiUserEnabled = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

import { GET } from './route';

describe('GET /api/auth/profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when multi user mode is off (no enumeration)', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns the profile list when multi user mode is on', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([
      { id: 'u1', username: 'andres', displayName: 'Andres', avatar: 'globe', passwordHash: 'h' },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.profiles[0].username).toBe('andres');
    expect(body.data.profiles[0].avatar).toBe('globe');
  });

  it('derives hasPassword and never leaks the hash in the response', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([
      { id: 'u1', username: 'a', displayName: 'A', avatar: null, passwordHash: 'secrethash' },
      { id: 'u2', username: 'b', displayName: 'B', avatar: 'globe', passwordHash: null },
    ]);
    const res = await GET();
    const body = await res.json();
    expect(body.data.profiles[0].hasPassword).toBe(true);
    expect(body.data.profiles[1].hasPassword).toBe(false);
    const str = JSON.stringify(body);
    expect(str).not.toContain('passwordHash');
    expect(str).not.toContain('secrethash');
  });
});
