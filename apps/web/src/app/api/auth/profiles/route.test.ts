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
      { id: 'u1', username: 'andres', displayName: 'Andres', avatar: 'globe' },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.profiles[0].username).toBe('andres');
    expect(body.data.profiles[0].avatar).toBe('globe');
  });

  it('selects only safe fields -- never the password hash', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([]);
    await GET();
    const select = (mockFindMany.mock.calls[0]![0] as { select: Record<string, unknown> }).select;
    expect(select.passwordHash).toBeUndefined();
    expect(select.id).toBe(true);
    expect(select.avatar).toBe(true);
  });
});
