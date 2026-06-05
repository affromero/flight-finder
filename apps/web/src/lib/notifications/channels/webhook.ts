import crypto from 'crypto';
import type { ChannelMessage, WebhookConfig } from './types';
import { assertPublicUrl } from './config';

export async function sendWebhook(
  config: WebhookConfig,
  message: ChannelMessage,
  opts: { trusted: boolean } = { trusted: true },
): Promise<void> {
  // Untrusted (per-user) channels may not point a webhook at internal hosts.
  assertPublicUrl(config.url, { trusted: opts.trusted });
  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url,
    data: message.data,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.secret) {
    const sig = crypto.createHmac('sha256', config.secret).update(payload).digest('hex');
    headers['X-Signature-256'] = `sha256=${sig}`;
  }
  const res = await fetch(config.url, { method: 'POST', headers, body: payload });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Webhook ${res.status}: ${detail.slice(0, 200)}`);
  }
}
