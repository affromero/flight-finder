import type { Dispatcher } from 'undici';
import { safeHttpUrl } from '@/lib/safe-url';
import { newLowText } from '../../content/new-low';
import type { ChannelMessage, WhatsAppConfig } from '../types';
import { pinnedPublicDispatcher } from '../config';
import { notificationBoundary, notificationDeadline, notificationPost, type NotificationTransportOptions } from '../transport';

function text(message: ChannelMessage, config: WhatsAppConfig): string {
  const data = message.data;
  let content = { title: message.title, body: message.body };
  if (typeof data.origin === 'string' && typeof data.destination === 'string' && typeof data.airline === 'string' && typeof data.travelDate === 'string'
    && (data.currency === null || typeof data.currency === 'string') && typeof data.currentMin === 'number' && Number.isFinite(data.currentMin)
    && typeof data.baseline === 'number' && Number.isFinite(data.baseline) && typeof data.drop === 'number' && Number.isFinite(data.drop)) {
    content = newLowText({ origin: data.origin, destination: data.destination, airline: data.airline, travelDate: data.travelDate,
      currency: data.currency, currentMin: data.currentMin, baseline: data.baseline, drop: data.drop }, config.locale);
  }
  const booking = typeof data.bookingUrl === 'string' ? safeHttpUrl(data.bookingUrl) : '';
  const tracker = config.includeTrackerLink ? safeHttpUrl(message.url) : '';
  const links = [...new Set([booking, tracker].filter(Boolean))];
  return [content.title, content.body, ...links].join('\n\n');
}

/** One destination per channel keeps independent receipts in the existing outbox. */
export async function sendWhatsApp(config: WhatsAppConfig, message: ChannelMessage,
  options: { trusted: boolean } & NotificationTransportOptions): Promise<void> {
  return notificationDeadline(async signal => {
    const path = config.destinationType === 'group' ? '/api/groups/send-message' : '/api/messages/send';
    const url = `${config.gatewayUrl}${path}`;
    const dispatcher = await notificationBoundary(pinnedPublicDispatcher(url, { trusted: options.trusted, signal }), signal);
    try {
      const body = { account: config.account, ...(config.destinationType === 'group' ? { groupId: config.destination } : { phone: config.destination }), message: text(message, config) };
      const request: RequestInit & { dispatcher?: Dispatcher } = { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey }, body: JSON.stringify(body) };
      if (dispatcher) request.dispatcher = dispatcher;
      await notificationPost(url, request, 'WhatsApp gateway', signal, { includeErrorDetail: false });
    } finally { await dispatcher?.destroy(); }
  }, options.signal);
}
