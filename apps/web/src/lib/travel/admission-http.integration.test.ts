import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createDatabaseSession } from '@/test/database-session';
import { sharedAccess } from '@/lib/sidedoor/access/service';
import { acquireTravelLease, getTravelAdmission, quarantineTravelLease } from './admission';
import { GET, POST } from '@/app/api/admin/travel/route';
import { GET as hotelStatus } from '@/app/api/hotels/search/[id]/route';
import { GET as carStatus } from '@/app/api/cars/search/[id]/route';
import { carSearchFixture } from '@/test/car-fixtures';
import { json } from '../hotels/store';

const boundary = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));

describe.skipIf(process.env.TRAVEL_INTEGRATION_TESTS !== '1')('administrator travel recovery HTTP against PostgreSQL', () => {
  let adminId = '', memberId = '';
  let previous: { multiUserMode: boolean; vpnProvider: string | null } | null;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Recovery HTTP tests require disposable localhost:55440/car_test');
    previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { multiUserMode: true, vpnProvider: true } });
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { multiUserMode: true, vpnProvider: 'none' }, update: { multiUserMode: true, vpnProvider: 'none' } });
    adminId = (await prisma.user.create({ data: { username: `recovery-admin-${crypto.randomUUID()}`, isAdmin: true } })).id;
    memberId = (await prisma.user.create({ data: { username: `recovery-member-${crypto.randomUUID()}` } })).id;
  });
  beforeEach(async () => {
    vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('REDIS_URL', '');
    boundary.token = await createDatabaseSession(adminId);
    await prisma.travelJob.deleteMany();
    await prisma.travelLease.deleteMany();
    await prisma.travelAdmission.deleteMany();
    const lease = await acquireTravelLease('browser');
    if (!lease) throw new Error('Expected isolated browser resource');
    await quarantineTravelLease(lease, 'Previous worker cleanup could not be verified');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await prisma.travelJob.deleteMany();
    await prisma.travelLease.deleteMany();
    await prisma.travelAdmission.deleteMany();
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId] } } });
    if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previous });
    else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    await prisma.$disconnect();
  });
  async function request() {
    return new Request('http://localhost/api/admin/travel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actorScope: process.env.SELF_HOSTED === 'true' ? `user:${adminId}` : 'instance', generation: (await getTravelAdmission()).recoveryGeneration, oldWorkersStopped: true, networkVerified: true }) });
  }
  it('rejects confirmations from another administrator before changing admission or worker leases', async () => {
    const original = await getTravelAdmission(), payload = await request();
    await prisma.user.update({ where: { id: memberId }, data: { isAdmin: true } });
    boundary.token = await createDatabaseSession(memberId);
    try {
      expect((await POST(payload)).status).toBe(412);
      expect(await getTravelAdmission()).toEqual(original);
      expect(await prisma.travelAdmission.findUnique({ where: { id: 'singleton' } })).toMatchObject({ recoveredBy: null });
    } finally { await prisma.user.update({ where: { id: memberId }, data: { isAdmin: false } }); }
  });
  it.each(['anonymous', 'member', 'revoked'] as const)('denies %s status and recovery without clearing the incident', async mode => {
    if (mode === 'anonymous') boundary.token = '';
    if (mode === 'member') boundary.token = await createDatabaseSession(memberId);
    if (mode === 'revoked') {
      boundary.token = await createDatabaseSession(memberId);
      await sharedAccess.store.transact(state => { state.principals.find(principal => principal.id === memberId)!.epoch++; });
    }
    const expected = mode === 'member' ? 403 : 401;
    const status = await GET(), recovery = await POST(await request());
    expect(status.status).toBe(expected); expect(recovery.status).toBe(expected);
    expect(status.headers.get('cache-control')).toBe('private, no-store');
    expect(recovery.headers.get('cache-control')).toBe('private, no-store');
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
  });
  it('allows a public-site administrator to recover flights but rejects a revoked administrator session', async () => {
    vi.stubEnv('SELF_HOSTED', 'false');
    boundary.token = await createDatabaseSession(adminId);
    expect((await (await GET()).json()).data.actorScope).toBe('instance');
    await sharedAccess.store.transact(state => { state.principals.find(principal => principal.id === adminId)!.epoch++; });
    expect((await GET()).status).toBe(401);
    expect((await POST(await request())).status).toBe(401);
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
    boundary.token = await createDatabaseSession(adminId);
    expect((await POST(await request())).status).toBe(200);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it('returns sanitized recovery state and applies one acknowledged administrator recovery', async () => {
    const status = await GET(); expect(status.status).toBe(200);
    const data = (await status.json()).data;
    expect(data).toMatchObject({ actorScope: `user:${adminId}`, reason: expect.stringMatching(/cleanup/), recoveryGeneration: expect.any(Number) });
    expect(JSON.stringify(data)).not.toMatch(/"owner"|topologyHash|EXPRESSVPN/);
    const first = await request(), retry = first.clone();
    const response = await POST(first); expect(response.status).toBe(200);
    expect((await response.json()).data.quarantinedAt).toBeNull();
    expect((await POST(retry)).status).toBe(412);
    expect(await prisma.travelAdmission.findUnique({ where: { id: 'singleton' } })).toMatchObject({ recoveredBy: adminId, recoveredAt: expect.any(Date) });
  });
  it('rejects malformed, oversized and non-JSON recovery bodies before clearing the incident', async () => {
    const base = 'http://localhost/api/admin/travel';
    expect((await POST(new Request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status).toBe(400);
    expect((await POST(new Request(base, { method: 'POST', body: '{}' }))).status).toBe(415);
    expect((await POST(new Request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(70_000) }))).status).toBe(413);
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
  });
  it.each(['hotel', 'car'] as const)('keeps %s search ownership private and gives members appropriate recovery guidance', async kind => {
    const row = kind === 'hotel'
      ? await prisma.hotelSearchRun.create({ data: { userId: adminId, request: {} } })
      : await prisma.carSearchRun.create({ data: { userId: adminId, request: json(carSearchFixture()) } });
    const read = kind === 'hotel' ? hotelStatus : carStatus;
    const context = { params: Promise.resolve({ id: row.id }) };
    try {
      const admin = await read(new Request('http://localhost'), context);
      expect(admin.status).toBe(503);
      expect((await admin.json()).error).toContain('/admin');
      boundary.token = await createDatabaseSession(memberId);
      expect((await read(new Request('http://localhost'), context)).status).toBe(404);
      if (kind === 'hotel') await prisma.hotelSearchRun.update({ where: { id: row.id }, data: { userId: memberId } });
      else await prisma.carSearchRun.update({ where: { id: row.id }, data: { userId: memberId } });
      const member = await read(new Request('http://localhost'), context);
      expect(member.status).toBe(503);
      const body = await member.json();
      expect(body.error).toMatch(/Ask your administrator/);
      expect(body.error).not.toContain('/admin');
    } finally {
      if (kind === 'hotel') await prisma.hotelSearchRun.delete({ where: { id: row.id } });
      else await prisma.carSearchRun.delete({ where: { id: row.id } });
    }
  });
});
