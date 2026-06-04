import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockFindMany = vi.fn();
const mockCreate = vi.fn();
const mockRequireAdmin = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    notificationChannel: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      create: (...a: unknown[]) => mockCreate(...a),
    },
  },
}));
vi.mock('@/lib/admin-guard', () => ({ requireAdminApi: () => mockRequireAdmin() }));

import { GET, POST } from './route';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/notifications', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(null);
  mockCreate.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: 'new-id',
      type: args.data.type,
      label: args.data.label,
      enabled: args.data.enabled,
      createdAt: new Date('2026-06-04T00:00:00Z'),
      config: args.data.config,
    }),
  );
});

describe('GET /api/admin/notifications', () => {
  it('never returns decrypted secrets, only presence flags', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'c1',
        type: 'telegram',
        label: 'Phone',
        enabled: true,
        createdAt: new Date('2026-06-04T00:00:00Z'),
        config: { botToken: 'iv:tag:cipher', chatId: '42' },
      },
    ]);
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    const cfg = data.data.channels[0].config;
    expect(cfg).toEqual({ chatId: '42', botTokenSet: true });
    expect(cfg.botToken).toBeUndefined();
  });

  it('blocks a non-admin caller', async () => {
    mockRequireAdmin.mockResolvedValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/notifications', () => {
  it('encrypts secret fields at rest and returns a redacted channel', async () => {
    const res = await POST(postReq({ type: 'telegram', label: 'Phone', config: { botToken: 'secret123', chatId: '42' } }));
    expect(res.status).toBe(201);

    const stored = (mockCreate.mock.calls[0]![0] as { data: { config: Record<string, unknown> } }).data.config;
    expect(stored.chatId).toBe('42');
    expect(stored.botToken).not.toBe('secret123'); // encrypted
    expect(String(stored.botToken)).toContain(':');

    const data = await res.json();
    expect(data.data.channel.config).toEqual({ chatId: '42', botTokenSet: true });
  });

  it('rejects an unknown channel type', async () => {
    const res = await POST(postReq({ type: 'carrier-pigeon', config: {} }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a config missing a required field', async () => {
    const res = await POST(postReq({ type: 'telegram', config: { botToken: 'x' } }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a webhook URL with a disallowed scheme', async () => {
    const res = await POST(postReq({ type: 'webhook', config: { url: 'ftp://example.com/hook' } }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows a webhook to a private host for the trusted admin owner', async () => {
    const res = await POST(postReq({ type: 'webhook', config: { url: 'http://localhost:9000/hook' } }));
    expect(res.status).toBe(201);
  });
});
