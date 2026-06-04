import type { ChannelMessage, StoredChannel } from './types';
import { decryptChannelConfig } from './config';
import { sendTelegram } from './telegram';
import { sendEmail } from './email';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';

/** Decrypt the stored config and dispatch the message to the matching sender. */
export async function sendToChannel(channel: StoredChannel, message: ChannelMessage): Promise<void> {
  switch (channel.type) {
    case 'telegram':
      return sendTelegram(decryptChannelConfig('telegram', channel.config), message);
    case 'email':
      return sendEmail(decryptChannelConfig('email', channel.config), message);
    case 'ntfy':
      return sendNtfy(decryptChannelConfig('ntfy', channel.config), message);
    case 'webhook':
      return sendWebhook(decryptChannelConfig('webhook', channel.config), message);
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
} from './config';
