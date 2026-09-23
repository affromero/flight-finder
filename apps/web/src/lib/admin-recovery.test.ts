import { beforeEach, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, session: '' }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access };
});
import { resetSharedPassword } from './admin-recovery';

beforeEach(async () => {
  boundary.fixture!.reset();
  boundary.session = await boundary.fixture!.issue('owner', true);
});
it('resets the shared password and revokes previous sessions and recovery codes', async () => {
  const codes = await boundary.fixture!.access.recoveryCodes(boundary.session);
  expect(await resetSharedPassword('replacement owner password')).toEqual({ ok: true });
  await expect(boundary.fixture!.access.authenticate(boundary.session)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(boundary.fixture!.access.recover(codes[0]!, 'another replacement password')).rejects.toMatchObject({ code: 'unauthorized' });
  const session = await boundary.fixture!.access.enterHousehold('replacement owner password');
  await boundary.fixture!.profiles.select(session, 'owner');
  expect((await boundary.fixture!.access.authenticate(session, true)).principal?.role).toBe('owner');
});
it('leaves existing access unchanged after an invalid new password', async () => {
  expect((await resetSharedPassword('short')).ok).toBe(false);
  expect((await boundary.fixture!.access.authenticate(boundary.session)).principal?.id).toBe('owner');
});
it('requires the first Admin profile to be claimed', async () => {
  boundary.fixture!.reset();
  expect(await resetSharedPassword('replacement owner password')).toEqual({
    ok: false,
    error: 'The first Admin profile has not been claimed',
  });
});
