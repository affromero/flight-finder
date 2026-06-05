import type { ChannelMessage, StoredChannel } from './types';
import { decryptChannelConfig } from './config';
import { sendTelegram } from './telegram';
import { sendEmail } from './email';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';

/**
 * A channel owned by `userId: null` is admin/global and trusted with internal
 * hosts (a local ntfy server, a private SMTP relay). A channel with a non-null
 * `userId` is per-user (multi-user mode) and untrusted, so its outbound
 * URLs/hosts are SSRF-checked at send time. A query owner can only ever attach
 * channels they own, so an absent owner id maps to the global/admin case.
 */
function isTrustedOwner(channel: SendChannel): boolean {
  return channel.userId == null;
}

/** A stored channel plus the optional owner id used to decide outbound trust. */
export type SendChannel = StoredChannel & { userId?: string | null };

/** Decrypt the stored config and dispatch the message to the matching sender. */
export async function sendToChannel(channel: SendChannel, message: ChannelMessage): Promise<void> {
  const trusted = isTrustedOwner(channel);
  switch (channel.type) {
    case 'telegram':
      return sendTelegram(decryptChannelConfig('telegram', channel.config), message);
    case 'email':
      return sendEmail(decryptChannelConfig('email', channel.config), message, { trusted });
    case 'ntfy':
      return sendNtfy(decryptChannelConfig('ntfy', channel.config), message, { trusted });
    case 'webhook':
      return sendWebhook(decryptChannelConfig('webhook', channel.config), message, { trusted });
    default:
      throw new Error(`Unknown channel type: ${channel.type as string}`);
  }
}

export * from './types';
export {
  CHANNEL_TYPES,
  SECRET_FIELDS,
  isChannelType,
  validateChannelConfig,
  encryptChannelConfig,
  decryptChannelConfig,
  prepareStoredConfig,
  mergeStoredConfig,
  redactChannelConfig,
  assertPublicUrl,
  assertPublicHost,
} from './config';
