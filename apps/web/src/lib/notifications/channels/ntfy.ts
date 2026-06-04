import type { ChannelMessage, NtfyConfig } from './types';

export async function sendNtfy(config: NtfyConfig, message: ChannelMessage): Promise<void> {
  const base = (config.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const endpoint = `${base}/${encodeURIComponent(config.topic)}`;
  const headers: Record<string, string> = {
    // ntfy header values must be latin-1 safe — strip anything outside ASCII.
    Title: message.title.replace(/[^\x20-\x7E]/g, ''),
    Tags: 'airplane',
  };
  if (message.url) headers.Click = message.url;
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const res = await fetch(endpoint, { method: 'POST', headers, body: message.body });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ntfy ${res.status}: ${detail.slice(0, 200)}`);
  }
}
