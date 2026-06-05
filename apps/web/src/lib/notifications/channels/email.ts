import nodemailer from 'nodemailer';
import type { ChannelMessage, EmailConfig } from './types';
import { assertPublicHost } from './config';

export async function sendEmail(
  config: EmailConfig,
  message: ChannelMessage,
  opts: { trusted: boolean } = { trusted: true },
): Promise<void> {
  // Untrusted (per-user) channels may not deliver via an internal SMTP host.
  assertPublicHost(config.host, { trusted: opts.trusted });
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  await transport.sendMail({
    from: config.from,
    to: config.to,
    subject: message.title,
    text: message.url ? `${message.body}\n\n${message.url}` : message.body,
    html: renderHtml(message),
  });
}

function renderHtml(message: ChannelMessage): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const link = message.url ? `<p><a href="${esc(message.url)}">Open</a></p>` : '';
  return `<p>${esc(message.body)}</p>${link}`;
}
