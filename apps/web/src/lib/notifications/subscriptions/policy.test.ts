import { describe, expect, it } from 'vitest';
import { parseNotificationPolicy } from './policy';
import { channelAuthority, decodeNotificationRouting } from './authority';

describe('notification settings input', () => {
  it('normalizes selected recipients while preserving the requested revision', () => {
    expect(parseNotificationPolicy({ mode: 'selected', channelIds: [' b ', 'a', 'b'], revision: 3 })).toEqual({ mode: 'selected', channelIds: ['a', 'b'], revision: 3 });
  });
  it('allows an explicit empty selection to mute a tracker', () => {
    expect(parseNotificationPolicy({ mode: 'selected', channelIds: [], revision: 0 })).toMatchObject({ mode: 'selected', channelIds: [] });
  });
  it.each([
    null, [], { mode: 'unknown', channelIds: [], revision: 0 }, { mode: 'inherit', channelIds: ['a'], revision: 0 },
    { mode: 'selected', channelIds: [null], revision: 0 }, { mode: 'selected', channelIds: [''], revision: 0 },
    { mode: 'selected', channelIds: [], revision: -1 }, { mode: 'selected', channelIds: [], revision: 0.5 },
    { mode: 'selected', channelIds: [], revision: '0' }, { mode: 'selected', channelIds: [], revision: 0, config: {} },
  ])('rejects malformed settings without choosing default recipients: %j', raw => {
    expect(() => parseNotificationPolicy(raw)).toThrow(/settings|Inherited/);
  });
});

describe('stored notification authority', () => {
  const version = channelAuthority({ type: 'webhook', userId: null, config: { url: 'https://example.com/hook' } });
  it('preserves inherited routing only for absent legacy metadata', () => {
    expect(decodeNotificationRouting(undefined)).toEqual({ mode: 'inherit', revision: 0, channels: [] });
  });
  it('retains explicit recipients and a removed recipient for delivery revocation', () => {
    const routing = { revision: 4, mode: 'selected', channels: [{ id: 'a', version }, { id: 'removed', version: null }] };
    expect(decodeNotificationRouting(routing)).toEqual(routing);
  });
  it.each([
    null, [], {}, { mode: 'inherit', revision: -1, channels: [] }, { mode: 'selected', revision: 1, channels: [{ id: 'a', version: 'invalid' }] },
    { mode: 'inherit', revision: 0, channels: [{ id: 'a', version }] },
    { mode: 'selected', revision: 1, channels: [{ id: 'a', version }, { id: 'a', version }] },
  ])('rejects present invalid routing instead of inheriting: %j', raw => {
    expect(() => decodeNotificationRouting(raw)).toThrow(/notification/i);
  });
  it('revokes a channel descriptor when its recipient, transport type or configuration changes', () => {
    const channel = { type: 'webhook', userId: null, config: { url: 'https://example.com/hook' } };
    expect(channelAuthority({ ...channel, userId: 'another-owner' })).not.toBe(version);
    expect(channelAuthority({ ...channel, type: 'ntfy' })).not.toBe(version);
    expect(channelAuthority({ ...channel, config: { url: 'https://example.com/new-recipient' } })).not.toBe(version);
  });
});
