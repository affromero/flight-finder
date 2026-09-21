import nodemailer from 'nodemailer';
import { connect, type Socket } from 'node:net';
import type { ChannelMessage, EmailConfig } from './types';
import { resolvePinnedPublicHost } from './config';
import { notificationBoundary, notificationDeadline, type NotificationTransportOptions } from './transport';

export async function sendEmail(
  config: EmailConfig,
  message: ChannelMessage,
  opts: { trusted: boolean } & NotificationTransportOptions = { trusted: true },
): Promise<void> {
  return notificationDeadline(async signal => {
    // Untrusted (per-user) channels may not deliver via an internal SMTP host.
    // Resolve the host, reject when it (or any resolved address) is private, and
    // get back the validated IP. nodemailer re-resolves the name otherwise, so a
    // host that passed the check could rebind to an internal IP at connect time
    // (SSRF-5). Pin by connecting to the validated IP while keeping the original
    // hostname as the TLS servername so certificate validation still matches.
    const pinnedAddress = await notificationBoundary(resolvePinnedPublicHost(config.host, { trusted: opts.trusted }), signal);
    signal.throwIfAborted();
    let socket: Socket | undefined;
    const abort = () => socket?.destroy();
    signal.addEventListener('abort', abort, { once: true });
    const transport = nodemailer.createTransport({
      host: pinnedAddress ?? config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000,
      getSocket(options, callback) {
        if (signal.aborted) { callback(new Error('Notification transport was cancelled'), {}); return; }
        socket = connect({ host: options.host ?? config.host, port: Number(options.port ?? config.port) });
        const failure = (error: Error) => callback(error, {});
        socket.once('error', failure);
        socket.once('connect', () => {
          socket!.removeListener('error', failure);
          if (signal.aborted) { socket!.destroy(); callback(new Error('Notification transport was cancelled'), {}); return; }
          callback(null, { connection: socket });
        });
      },
      ...(pinnedAddress ? { tls: { servername: config.host } } : {}),
    });
    try { await notificationBoundary(transport.sendMail({
      from: config.from,
      to: config.to,
      subject: message.title,
      text: message.url ? `${message.body}\n\n${message.url}` : message.body,
      html: renderHtml(message),
    }), signal); }
    finally { signal.removeEventListener('abort', abort); socket?.destroy(); transport.close(); }
  }, opts.signal);
}

function renderHtml(message: ChannelMessage): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const link = message.url ? `<p><a href="${esc(message.url)}">Open</a></p>` : '';
  return `<p>${esc(message.body)}</p>${link}`;
}
