export type ChannelType = 'telegram' | 'email' | 'ntfy' | 'webhook';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
}

export interface NtfyConfig {
  server: string; // base url, e.g. https://ntfy.sh
  topic: string;
  token?: string; // optional access token for protected topics
}

export interface WebhookConfig {
  url: string;
  secret?: string; // optional HMAC signing key (sent as X-Signature-256)
}

export interface ChannelConfigMap {
  telegram: TelegramConfig;
  email: EmailConfig;
  ntfy: NtfyConfig;
  webhook: WebhookConfig;
}

/** A notification ready to render across any channel. */
export interface ChannelMessage {
  title: string;
  body: string;
  url: string;
  data: Record<string, string | number | boolean | null>;
}

/** A stored channel row, as far as the senders care. `config` is raw JSON from
 * the DB with secret fields still encrypted. */
export interface StoredChannel {
  id: string;
  type: ChannelType;
  config: unknown;
}
