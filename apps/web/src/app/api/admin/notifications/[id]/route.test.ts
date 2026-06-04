import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { encryptSecret } from '@/lib/secret-crypto';

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRequireAdmin = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    notificationChannel: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
    },
  },
}));
vi.mock('@/lib/admin-guard', () => ({ requireAdminApi: () => mockRequireAdmin() }));

import { PATCH, DELETE } from './route';

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/notifications/c1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
function ctx(id = 'c1') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(null);
  mockUpdate.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: 'c1',
      type: 'telegram',
      label: args.data.label ?? 'Phone',
      enabled: args.data.enabled ?? true,
      createdAt: new Date('2026-06-04T00:00:00Z'),
      config: args.data.config ?? { botToken: 'x', chatId: '42' },
    }),
  );
});

describe('PATCH /api/admin/notifications/[id]', () => {
  it('toggles enabled without rewriting the config', async () => {
    mockFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encryptSecret('tok'), chatId: '42' } });
    const res = await PATCH(patchReq({ enabled: false }), ctx());
    expect(res.status).toBe(200);
    const data = (mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.enabled).toBe(false);
    expect(data.config).toBeUndefined();
  });

  it('keeps the existing encrypted secret when the update leaves it blank', async () => {
    const encTok = encryptSecret('tok');
    mockFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encTok, chatId: '42' } });
    const res = await PATCH(patchReq({ config: { chatId: '99' } }), ctx());
    expect(res.status).toBe(200);
    const stored = (mockUpdate.mock.calls[0]![0] as { data: { config: Record<string, unknown> } }).data.config;
    expect(stored.chatId).toBe('99');
    expect(stored.botToken).toBe(encTok); // untouched
  });

  it('re-encrypts a newly provided secret', async () => {
    const encTok = encryptSecret('tok');
    mockFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encTok, chatId: '42' } });
    const res = await PATCH(patchReq({ config: { chatId: '42', botToken: 'newtoken' } }), ctx());
    expect(res.status).toBe(200);
    const stored = (mockUpdate.mock.calls[0]![0] as { data: { config: Record<string, unknown> } }).data.config;
    expect(stored.botToken).not.toBe('newtoken');
    expect(stored.botToken).not.toBe(encTok);
    expect(String(stored.botToken)).toContain(':');
  });

  it('clears an optional secret when the field is sent as null', async () => {
    const encSecret = encryptSecret('shh');
    mockFindFirst.mockResolvedValue({ id: 'c1', type: 'webhook', config: { url: 'https://hook.example', secret: encSecret } });
    mockUpdate.mockImplementation((args: { data: { config: unknown } }) =>
      Promise.resolve({ id: 'c1', type: 'webhook', label: null, enabled: true, createdAt: new Date('2026-06-04T00:00:00Z'), config: args.data.config }),
    );
    const res = await PATCH(patchReq({ config: { url: 'https://hook.example', secret: null } }), ctx());
    expect(res.status).toBe(200);
    const stored = (mockUpdate.mock.calls[0]![0] as { data: { config: Record<string, unknown> } }).data.config;
    expect(stored.secret).toBeUndefined();
    expect(stored.url).toBe('https://hook.example');
  });

  it('returns 404 for a missing or non-global channel', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await PATCH(patchReq({ enabled: false }), ctx('nope'));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('blocks a non-admin caller', async () => {
    mockRequireAdmin.mockResolvedValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await PATCH(patchReq({ enabled: false }), ctx());
    expect(res.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/notifications/[id]', () => {
  it('deletes an existing global channel', async () => {
    mockFindFirst.mockResolvedValue({ id: 'c1' });
    mockDelete.mockResolvedValue({});
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx());
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('returns 404 when the channel does not exist', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx('nope'));
    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
