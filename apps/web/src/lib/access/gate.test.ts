import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PASSWORD = 'a-long-enough-gate-password';

async function gate() {
  return import('./gate');
}

describe('access gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('FF_ACCESS_PASSWORD', PASSWORD);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('stays inert when no password is configured', async () => {
    vi.stubEnv('FF_ACCESS_PASSWORD', '');
    const { gateEnabled, createSessionToken } = await gate();

    expect(gateEnabled()).toBe(false);
    // Nothing to sign with, so nothing is issued — the middleware treats an
    // unset password as "this instance is public", not "lock everyone out".
    expect(await createSessionToken()).toBeNull();
  });

  it('refuses a password too short to derive a key from', async () => {
    vi.stubEnv('FF_ACCESS_PASSWORD', 'short');
    const { gateEnabled, verifyAccessPassword } = await gate();

    expect(gateEnabled()).toBe(false);
    expect(await verifyAccessPassword('short')).toBe(false);
  });

  it('admits the configured password and rejects anything else', async () => {
    const { verifyAccessPassword } = await gate();

    expect(await verifyAccessPassword(PASSWORD)).toBe(true);
    expect(await verifyAccessPassword(`${PASSWORD}x`)).toBe(false);
    expect(await verifyAccessPassword('')).toBe(false);
  });

  it('round-trips a session token', async () => {
    const { createSessionToken, verifySessionToken } = await gate();

    const token = await createSessionToken();
    expect(await verifySessionToken(token!)).toBe(true);
  });

  it('rejects an invite replayed as a session cookie, and the reverse', async () => {
    // The scope is signed AND checked, so the two token kinds cannot be
    // substituted for one another even though they share a key.
    const { createInviteToken, createSessionToken, verifyInviteToken, verifySessionToken } =
      await gate();

    const invite = await createInviteToken();
    const session = await createSessionToken();

    expect(await verifySessionToken(invite!)).toBe(false);
    expect(await verifyInviteToken(session!)).toBe(false);
  });

  it('rejects a tampered signature and a tampered expiry', async () => {
    const { createSessionToken, verifySessionToken } = await gate();
    const token = (await createSessionToken())!;
    const [scope, expiry, sig] = token.split('.');

    const changedDigit = sig!.endsWith('0') ? '1' : '0';
    expect(await verifySessionToken(`${scope}.${expiry}.${sig!.slice(0, -1)}${changedDigit}`)).toBe(false);
    // Pushing the expiry out invalidates the signature, which covers it.
    expect(await verifySessionToken(`${scope}.${Number(expiry) + 60_000}.${sig}`)).toBe(false);
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    const { createSessionToken, verifySessionToken } = await gate();
    const token = (await createSessionToken())!;

    vi.advanceTimersByTime(13 * 60 * 60 * 1000);
    expect(await verifySessionToken(token)).toBe(false);
  });

  it('stops honouring tokens once the password changes', async () => {
    const { createSessionToken } = await gate();
    const token = (await createSessionToken())!;

    vi.resetModules();
    vi.stubEnv('FF_ACCESS_PASSWORD', 'a-different-long-gate-password');
    const { verifySessionToken } = await gate();

    // Rotating the password revokes outstanding access, which is the whole
    // reason the key is derived from it.
    expect(await verifySessionToken(token)).toBe(false);
  });

  describe('machine token', () => {
    it('admits the configured bearer token', async () => {
      vi.stubEnv('FF_MACHINE_TOKEN', 'a-long-enough-machine-token');
      const { verifyMachineToken } = await gate();

      expect(await verifyMachineToken('Bearer a-long-enough-machine-token')).toBe(true);
      expect(await verifyMachineToken('Bearer wrong-but-long-enough-token')).toBe(false);
      expect(await verifyMachineToken('a-long-enough-machine-token')).toBe(false);
      expect(await verifyMachineToken(null)).toBe(false);
    });

    it('is inert when unset, so an empty header cannot walk in', async () => {
      vi.stubEnv('FF_MACHINE_TOKEN', '');
      const { verifyMachineToken } = await gate();

      expect(await verifyMachineToken('Bearer ')).toBe(false);
      expect(await verifyMachineToken('Bearer anything')).toBe(false);
    });

    it('refuses a machine token too short to be worth trusting', async () => {
      vi.stubEnv('FF_MACHINE_TOKEN', 'short');
      const { verifyMachineToken } = await gate();

      expect(await verifyMachineToken('Bearer short')).toBe(false);
    });
  });
});
