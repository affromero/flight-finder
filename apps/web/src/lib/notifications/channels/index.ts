import type { ChannelMessage, StoredChannel } from './types';
import { decryptChannelConfig } from './config';
import { sendTelegram } from './telegram';
import { sendEmail } from './email';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';
import { sendPushover } from './pushover/send';
import type { NotificationTransportOptions } from './transport';

/**
 * A channel owned by `userId: null` is admin/global and trusted with internal
 * hosts (a local ntfy server, a private SMTP relay). A channel with any other
 * `userId` is per-user (multi-user mode) and untrusted, so its outbound
 * URLs/hosts are SSRF-checked at send time. Only an explicit `null` is trusted:
 * a caller must commit to the owner, so loading a user-owned channel and
 * omitting the id can never silently downgrade it to the trusted/global case.
 */
function isTrustedOwner(channel: SendChannel): boolean {
  return channel.userId === null;
}

/** A stored channel plus the owner id used to decide outbound trust. The id is
 * required (null = global/admin, any string = untrusted per-user) so a caller
 * can never accidentally omit it and bypass the SSRF checks. */
export type SendChannel = StoredChannel & { userId: string | null };

/** Decrypt the stored config and dispatch the message to the matching sender. */
export async function sendToChannel(channel: SendChannel, message: ChannelMessage, options: NotificationTransportOptions = {}): Promise<void> {
  const trusted = isTrustedOwner(channel);
  switch (channel.type) {
    case 'telegram':
      return sendTelegram(decryptChannelConfig('telegram', channel.config), message, options);
    case 'email':
      return sendEmail(decryptChannelConfig('email', channel.config), message, { ...options, trusted });
    case 'ntfy':
      return sendNtfy(decryptChannelConfig('ntfy', channel.config), message, { ...options, trusted });
    case 'webhook':
      return sendWebhook(decryptChannelConfig('webhook', channel.config), message, { ...options, trusted });
    case 'pushover':
      return sendPushover(decryptChannelConfig('pushover', channel.config), message, options);
    default:
      throw new Error(`Unknown channel type: ${channel.type as string}`);
  }
}

export * from './types';
export {
  isChannelType,
  prepareStoredConfig,
  mergeStoredConfig,
  redactChannelConfig,
  assertPublicUrl,
} from './config';
