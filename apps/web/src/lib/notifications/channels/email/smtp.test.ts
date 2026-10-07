import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { sendEmail } from '../email';
import type { EmailConfig } from '../types';

vi.mock('node:dns/promises', async original => ({
  ...await original<typeof import('node:dns/promises')>(),
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));
// Replace only the outbound TCP destination. Nodemailer and SMTP remain real.
vi.mock('node:net', async original => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, connect: (options: { host: string; port: number }) => actual.createConnection({
    ...options, host: options.host === '93.184.216.34' ? '127.0.0.1' : options.host,
  }) };
});

async function smtpFixture(advertiseTls: boolean) {
  const commands: string[] = [], messages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 smtp.example ESMTP fixture\r\n');
    let pending = '', message: string[] | undefined;
    socket.on('data', data => {
      pending += data.toString();
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (message) {
          if (line !== '.') { message.push(line); continue; }
          messages.push(message.join('\n')); message = undefined;
          socket.write('250 Message accepted\r\n'); continue;
        }
        commands.push(line);
        if (/^EHLO\b/.test(line)) socket.write(`250-smtp.example\r\n${advertiseTls ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`);
        else if (line === 'STARTTLS') socket.write('502 TLS unavailable\r\n');
        else if (/^AUTH\b/.test(line)) socket.write('235 Authentication accepted\r\n');
        else if (line === 'DATA') { message = []; socket.write('354 Send message\r\n'); }
        else if (line === 'QUIT') socket.end('221 Goodbye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing SMTP fixture port');
  const config: EmailConfig = { host: 'smtp.example', port: address.port, secure: false, user: 'fixture-user', pass: 'fixture-password', from: 'sender@example.com', to: 'recipient@example.com' };
  return { commands, messages, config, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

const alert = { title: 'Flight price alert', body: 'Your flight dropped to EUR 250.', url: '', data: {} };

describe('SMTP encryption for private notification channels', () => {
  it.each([true, false])('refuses a plaintext server before sending a private alert (authentication: %s)', async authenticate => {
    const fixture = await smtpFixture(false);
    try {
      const config = { ...fixture.config, user: authenticate ? fixture.config.user : undefined, pass: authenticate ? fixture.config.pass : undefined };
      await expect(sendEmail(config, alert, { trusted: false })).rejects.toThrow(/TLS/i);
      expect(fixture.commands.some(command => /^(AUTH|MAIL|RCPT|DATA)\b/.test(command))).toBe(false);
      expect(fixture.messages).toEqual([]);
    } finally { await fixture.close(); }
  });

  it('refuses a failed advertised TLS upgrade without falling back to plaintext delivery', async () => {
    const fixture = await smtpFixture(true);
    try {
      await expect(sendEmail(fixture.config, alert, { trusted: false })).rejects.toThrow(/TLS/i);
      expect(fixture.commands.some(command => /^(AUTH|MAIL|RCPT|DATA)\b/.test(command))).toBe(false);
      expect(fixture.messages).toEqual([]);
    } finally { await fixture.close(); }
  });

  it.each([undefined, { trusted: true }])('delivers through a trusted plaintext relay with options %j', async options => {
    const fixture = await smtpFixture(false);
    try {
      await sendEmail({ ...fixture.config, host: '127.0.0.1' }, alert, options);
      expect(fixture.messages).toEqual([expect.stringContaining(alert.body)]);
      expect(fixture.messages[0]).toContain(`Subject: ${alert.title}`);
    } finally { await fixture.close(); }
  });
});
