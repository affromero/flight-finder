import nodemailer from 'nodemailer';
import type { ChannelMessage, EmailConfig } from './types';

export async function sendEmail(config: EmailConfig, message: ChannelMessage): Promise<void> {
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
    text: `${message.body}\n\n${message.url}`,
    html: renderHtml(message),
  });
}

function renderHtml(message: ChannelMessage): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<p>${esc(message.body)}</p><p><a href="${esc(message.url)}">View price history</a></p>`;
}
