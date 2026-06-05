import nodemailer from 'nodemailer';
import type { ChannelMessage, EmailConfig } from './types';
import { resolvePinnedPublicHost } from './config';

export async function sendEmail(
  config: EmailConfig,
  message: ChannelMessage,
  opts: { trusted: boolean } = { trusted: true },
): Promise<void> {
  // Untrusted (per-user) channels may not deliver via an internal SMTP host.
  // Resolve the host, reject when it (or any resolved address) is private, and
  // get back the validated IP. nodemailer re-resolves the name otherwise, so a
  // host that passed the check could rebind to an internal IP at connect time
  // (SSRF-5). Pin by connecting to the validated IP while keeping the original
  // hostname as the TLS servername so certificate validation still matches.
  const pinnedAddress = await resolvePinnedPublicHost(config.host, { trusted: opts.trusted });
  const transport = nodemailer.createTransport({
    host: pinnedAddress ?? config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    ...(pinnedAddress ? { tls: { servername: config.host } } : {}),
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
