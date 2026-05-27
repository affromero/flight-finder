import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQueryFindUnique = vi.fn();
const mockQueryUpdate = vi.fn();
const mockQueryUpdateMany = vi.fn();
const mockQueryDelete = vi.fn();
const mockQueryDeleteMany = vi.fn();
const mockUserFindUnique = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: {
      findUnique: (...args: unknown[]) => mockQueryFindUnique(...args),
      update: (...args: unknown[]) => mockQueryUpdate(...args),
      updateMany: (...args: unknown[]) => mockQueryUpdateMany(...args),
      delete: (...args: unknown[]) => mockQueryDelete(...args),
      deleteMany: (...args: unknown[]) => mockQueryDeleteMany(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
  },
}));

vi.mock('@/lib/admin-guard', () => ({
  requireAdminApi: () => Promise.resolve(null),
}));

import { DELETE, PATCH } from './route';

function patchRequest(id: string, body: Record<string, unknown>): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/admin/queries/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ];
}

function deleteRequest(id: string, body?: Record<string, unknown>): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/admin/queries/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe('admin PATCH /api/admin/queries/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryUpdate.mockResolvedValue({});
    mockQueryUpdateMany.mockResolvedValue({ count: 0 });
  });

  it('cascades active to every sibling when the query has a groupId', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: 'g1' });
    mockQueryUpdateMany.mockResolvedValue({ count: 3 });
    const res = await PATCH(...patchRequest('q1', { active: false }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toMatchObject({ active: false, updated: 3 });
    expect(mockQueryUpdateMany).toHaveBeenCalledWith({
      where: { groupId: 'g1' },
      data: { active: false },
    });
    expect(mockQueryUpdate).not.toHaveBeenCalled();
  });

  it('cascades scrapeInterval to siblings', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: 'g1' });
    mockQueryUpdateMany.mockResolvedValue({ count: 2 });
    const res = await PATCH(...patchRequest('q1', { scrapeInterval: 6 }));
    expect(res.status).toBe(200);
    expect(mockQueryUpdateMany).toHaveBeenCalledWith({
      where: { groupId: 'g1' },
      data: { scrapeInterval: 6 },
    });
  });

  it('updates single row when query has no groupId', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: null });
    const res = await PATCH(...patchRequest('q1', { active: true }));
    expect(res.status).toBe(200);
    expect(mockQueryUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { active: true },
    });
    expect(mockQueryUpdateMany).not.toHaveBeenCalled();
  });

  it('updates label as single-row (no cascade)', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: 'g1' });
    const res = await PATCH(...patchRequest('q1', { label: 'My tracker' }));
    expect(res.status).toBe(200);
    expect(mockQueryUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { label: 'My tracker' },
    });
    expect(mockQueryUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects label longer than 60 characters', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: null });
    const res = await PATCH(...patchRequest('q1', { label: 'x'.repeat(61) }));
    expect(res.status).toBe(400);
    expect(mockQueryUpdate).not.toHaveBeenCalled();
  });

  it('keeps userId reassignment single-row even on a grouped query', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: 'g1' });
    mockUserFindUnique.mockResolvedValue({ id: 'user_42' });
    const res = await PATCH(...patchRequest('q1', { userId: 'user_42' }));
    expect(res.status).toBe(200);
    expect(mockQueryUpdate).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { userId: 'user_42' },
    });
    expect(mockQueryUpdateMany).not.toHaveBeenCalled();
  });
});

describe('admin DELETE /api/admin/queries/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryDelete.mockResolvedValue({});
    mockQueryDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('deletes the whole group when groupDelete=true', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: 'g1' });
    mockQueryDeleteMany.mockResolvedValue({ count: 4 });
    const res = await DELETE(...deleteRequest('q1', { groupDelete: true }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toEqual({ deleted: true, groupDeleted: true, count: 4 });
    expect(mockQueryDeleteMany).toHaveBeenCalledWith({ where: { groupId: 'g1' } });
    expect(mockQueryDelete).not.toHaveBeenCalled();
  });

  it('falls back to single-row delete when groupId is null even if groupDelete=true', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: null });
    const res = await DELETE(...deleteRequest('q1', { groupDelete: true }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toEqual({ deleted: true, groupDeleted: false });
    expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
    expect(mockQueryDeleteMany).not.toHaveBeenCalled();
  });

  it('deletes single row when groupDelete is omitted', async () => {
    mockQueryFindUnique.mockResolvedValue({ groupId: 'g1' });
    const res = await DELETE(...deleteRequest('q1'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toEqual({ deleted: true, groupDeleted: false });
    expect(mockQueryDelete).toHaveBeenCalledWith({ where: { id: 'q1' } });
    expect(mockQueryDeleteMany).not.toHaveBeenCalled();
  });
});
