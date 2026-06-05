import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFindMany = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: { notificationChannel: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import { dispatchNotifications } from './notify';
import { encryptChannelConfig } from './channels/config';
import type { ChannelMessage } from './channels/types';

const MESSAGE: ChannelMessage = {
  title: 'New low: LHR to JFK $250',
  body: 'LHR to JFK dropped to $250.',
  url: 'https://flights.example/q/abc',
  data: { queryId: 'abc' },
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      String(url).includes('bad.example')
        ? { ok: false, status: 500, text: async () => 'boom' }
        : { ok: true, status: 200, text: async () => '' },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('dispatchNotifications', () => {
  it('includes the global channels for an owned query (so multi-user alerts still fire)', async () => {
    mockFindMany.mockResolvedValue([]);
    await dispatchNotifications('user-1', MESSAGE);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enabled: true, OR: [{ userId: 'user-1' }, { userId: null }] },
      }),
    );
  });

  it('scopes to global channels when the owner is null', async () => {
    mockFindMany.mockResolvedValue([]);
    await dispatchNotifications(null, MESSAGE);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true, userId: null } }),
    );
  });

  it('delivers an owned query to a global channel', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'g1', type: 'telegram', config: encryptChannelConfig('telegram', { botToken: 'T', chatId: '1' }), userId: null },
    ]);
    const outcomes = await dispatchNotifications('user-1', MESSAGE);
    expect(outcomes).toEqual([{ channelId: 'g1', type: 'telegram', ok: true }]);
  });

  it('delivers to every channel and reports per-channel success', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'c1', type: 'telegram', config: encryptChannelConfig('telegram', { botToken: 'T', chatId: '1' }), userId: null },
      { id: 'c2', type: 'ntfy', config: { server: 'https://ntfy.sh', topic: 'flights' }, userId: null },
    ]);
    const outcomes = await dispatchNotifications(null, MESSAGE);
    expect(outcomes).toEqual([
      { channelId: 'c1', type: 'telegram', ok: true },
      { channelId: 'c2', type: 'ntfy', ok: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('isolates a failing channel so the others still deliver', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'good', type: 'telegram', config: encryptChannelConfig('telegram', { botToken: 'T', chatId: '1' }) },
      { id: 'bad', type: 'webhook', config: { url: 'https://bad.example/hook' }, userId: null },
    ]);
    const outcomes = await dispatchNotifications(null, MESSAGE);
    const good = outcomes.find((o) => o.channelId === 'good')!;
    const bad = outcomes.find((o) => o.channelId === 'bad')!;
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/500/);
  });

  it('loads the channel owner id so per-user trust can be decided downstream', async () => {
    mockFindMany.mockResolvedValue([]);
    await dispatchNotifications('user-1', MESSAGE);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ userId: true }),
      }),
    );
  });

  it('treats a per-user (userId set) channel as untrusted and blocks an internal webhook host', async () => {
    // The owner id is threaded through to the sender, so a user-owned channel
    // aimed at the cloud metadata IP must be SSRF-blocked, never delivered.
    mockFindMany.mockResolvedValue([
      {
        id: 'u1',
        type: 'webhook',
        config: { url: 'http://169.254.169.254/latest/meta-data' },
        userId: 'user-1',
      },
    ]);
    const outcomes = await dispatchNotifications('user-1', MESSAGE);
    expect(outcomes).toEqual([
      { channelId: 'u1', type: 'webhook', ok: false, error: expect.stringMatching(/not allowed/) },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a global (userId null) channel trusted so an internal host still delivers', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'g1', type: 'webhook', config: { url: 'http://127.0.0.1/hook' }, userId: null },
    ]);
    const outcomes = await dispatchNotifications(null, MESSAGE);
    expect(outcomes).toEqual([{ channelId: 'g1', type: 'webhook', ok: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
