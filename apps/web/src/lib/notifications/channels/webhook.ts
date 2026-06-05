import crypto from 'crypto';
import type { Dispatcher } from 'undici';
import type { ChannelMessage, WebhookConfig } from './types';
import { pinnedPublicDispatcher } from './config';

type FetchInit = RequestInit & { dispatcher?: Dispatcher };

export async function sendWebhook(
  config: WebhookConfig,
  message: ChannelMessage,
  opts: { trusted: boolean } = { trusted: true },
): Promise<void> {
  // Untrusted (per-user) channels may not point a webhook at internal hosts.
  // For a hostname this resolves and validates the address, then pins the socket
  // to it so the connection cannot rebind to an internal IP after the check.
  const dispatcher = await pinnedPublicDispatcher(config.url, { trusted: opts.trusted });
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
  const init: FetchInit = { method: 'POST', headers, body: payload };
  if (dispatcher) init.dispatcher = dispatcher;
  const res = await fetch(config.url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Webhook ${res.status}: ${detail.slice(0, 200)}`);
  }
}
