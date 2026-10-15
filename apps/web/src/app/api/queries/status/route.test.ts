import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { query: { findMany: database.findMany } } }));

import { POST } from './route';

afterEach(() => vi.useRealTimers());

describe('saved tracker expiry status', () => {
  it('uses outbound UTC days for legacy trackers and keeps rolling seeds live', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-05-01T23:59:59Z'));
    database.findMany.mockResolvedValue([
      { id: 'today', active: true, isSeed: false, dateFrom: new Date('2027-05-01'), expiresAt: new Date('2027-05-01') },
      { id: 'departed', active: true, isSeed: false, dateFrom: new Date('2027-04-30'), expiresAt: new Date('2027-05-20') },
      { id: 'seed', active: true, isSeed: true, dateFrom: new Date('2000-01-01') },
    ]);
    const request = () => new NextRequest('http://localhost/api/queries/status', {
      method: 'POST', body: JSON.stringify({ ids: ['today', 'departed', 'seed', 'missing'] }),
    });
    expect((await (await POST(request())).json()).data).toEqual({
      today: 'active', departed: 'expired', seed: 'active', missing: 'deleted',
    });
    vi.setSystemTime(new Date('2027-05-02T00:00:00Z'));
    expect((await (await POST(request())).json()).data.today).toBe('expired');
  });
});
