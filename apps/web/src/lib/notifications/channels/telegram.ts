import type { ChannelMessage, TelegramConfig } from './types';

export async function sendTelegram(config: TelegramConfig, message: ChannelMessage): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const text = message.url
    ? `${message.title}\n\n${message.body}\n\n${message.url}`
    : `${message.title}\n\n${message.body}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Telegram API ${res.status}: ${detail.slice(0, 200)}`);
  }
}
