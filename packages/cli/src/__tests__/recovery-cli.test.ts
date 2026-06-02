import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReset, mockDisable, mockDisconnect } = vi.hoisted(() => ({
  mockReset: vi.fn(),
  mockDisable: vi.fn(),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/admin-recovery', () => ({
  resetUserPassword: mockReset,
  disableMultiUserMode: mockDisable,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { $disconnect: mockDisconnect },
}));

import { runResetPassword, runDisableAccounts } from '../lib/recovery-cli.js';

function spies() {
  return {
    exit: vi.spyOn(process, 'exit').mockImplementation(() => undefined as never),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

describe('runResetPassword', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('forwards the credentials, confirms success, disconnects, and exits 0', async () => {
    const s = spies();
    mockReset.mockResolvedValue({ ok: true, isAdmin: true });

    await runResetPassword('garry', 'correcthorse');

    expect(mockReset).toHaveBeenCalledWith('garry', 'correcthorse');
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('garry'));
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it('prints the error and exits 1 when the reset fails', async () => {
    const s = spies();
    mockReset.mockResolvedValue({ ok: false, error: 'User "ghost" not found' });

    await runResetPassword('ghost', 'correcthorse');

    expect(s.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('runDisableAccounts', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('disables multi user mode, confirms, disconnects, and exits 0', async () => {
    const s = spies();
    mockDisable.mockResolvedValue(undefined);

    await runDisableAccounts();

    expect(mockDisable).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it('reports a failure and exits 1 when the disable throws', async () => {
    const s = spies();
    mockDisable.mockRejectedValue(new Error('DB down'));

    await runDisableAccounts();

    expect(s.error).toHaveBeenCalledWith(expect.stringContaining('DB down'));
    expect(s.exit).toHaveBeenCalledWith(1);
  });
});
