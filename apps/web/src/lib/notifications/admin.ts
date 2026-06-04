import { redactChannelConfig, assertPublicUrl, type ChannelType } from './channels';

export interface ChannelRow {
  id: string;
  type: string;
  label: string | null;
  config: unknown;
  enabled: boolean;
  createdAt: Date;
}

/** Shape a stored channel row for the client, with secret values stripped. */
export function redactChannel(channel: ChannelRow) {
  return {
    id: channel.id,
    type: channel.type,
    label: channel.label,
    enabled: channel.enabled,
    createdAt: channel.createdAt,
    config: redactChannelConfig(channel.type as ChannelType, channel.config),
  };
}

/**
 * SSRF + scheme guard for URL-bearing channels. The admin/global owner is
 * trusted, so private hosts are allowed (e.g. a local ntfy server), but bad
 * schemes and embedded credentials are always rejected.
 */
export function assertChannelUrls(type: ChannelType, rawConfig: unknown): void {
  const c = (rawConfig ?? {}) as Record<string, unknown>;
  if (type === 'webhook' && typeof c.url === 'string') {
    assertPublicUrl(c.url, { trusted: true });
  }
  if (type === 'ntfy' && typeof c.server === 'string' && c.server.trim() && c.server !== 'https://ntfy.sh') {
    assertPublicUrl(c.server, { trusted: true });
  }
}
