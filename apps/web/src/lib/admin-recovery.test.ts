import { beforeEach, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, exists: true, session: '' }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access };
});
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: async () => boundary.exists ? { id: 'owner' } : null } } }));
import { resetUserPassword } from './admin-recovery';

beforeEach(async () => {
  boundary.fixture!.reset();
  boundary.exists = true;
  boundary.session = await boundary.fixture!.issue('owner', true);
});
it('resets a local account through shared credentials and revokes previous sessions and recovery codes', async () => {
  const codes = await boundary.fixture!.access.recoveryCodes(boundary.session);
  expect(await resetUserPassword('owner', 'replacement owner password')).toEqual({ ok: true, isAdmin: true });
  await expect(boundary.fixture!.access.authenticate(boundary.session)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(boundary.fixture!.access.recover(codes[0]!, 'another replacement password')).rejects.toMatchObject({ code: 'unauthorized' });
  const session = await boundary.fixture!.access.enterHousehold('replacement owner password');
  await boundary.fixture!.profiles.select(session, 'owner');
  expect((await boundary.fixture!.access.authenticate(session, true)).principal?.role).toBe('owner');
});
it('leaves existing access unchanged after an invalid new password or missing account', async () => {
  expect((await resetUserPassword('owner', 'short')).ok).toBe(false);
  boundary.exists = false;
  expect((await resetUserPassword('missing', 'replacement owner password')).ok).toBe(false);
  expect((await boundary.fixture!.access.authenticate(boundary.session)).principal?.id).toBe('owner');
});
