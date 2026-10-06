import type { ChannelMessage, PushoverConfig } from '../types';
import { notificationDeadline, notificationJson, notificationPost, type NotificationTransportOptions } from '../transport';

function boundedText(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : value;
}

export async function sendPushover(config: PushoverConfig, message: ChannelMessage, options: NotificationTransportOptions = {}): Promise<void> {
  return notificationDeadline(async signal => {
    const form = new URLSearchParams({ token: config.token, user: config.userKey, title: boundedText(message.title, 250), message: boundedText(message.body, 1024), priority: String(config.priority) });
    if (message.url && Array.from(message.url).length <= 512) { form.set('url', message.url); form.set('url_title', 'View tracker'); }
    if (config.device) form.set('device', config.device);
    if (config.priority === 2) { form.set('retry', String(config.retry)); form.set('expire', String(config.expire)); }
    await notificationPost('https://api.pushover.net/1/messages.json', {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    }, 'Pushover', signal, {
      includeErrorDetail: false,
      accepted: async response => {
        const result = await notificationJson(response, signal);
        if (!result || typeof result !== 'object' || !('status' in result) || result.status !== 1) {
          throw new Error('Pushover did not accept the notification');
        }
      },
    });
  }, options.signal);
}
