import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const mockSendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mockSendMail })) },
}));

// DNS boundary: lets tests drive what a hostname resolves to, so the resolve-and-
// validate / pinning path (SSRF-5) can be exercised without real network lookups.
const mockDnsLookup = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

import nodemailer from 'nodemailer';
import { sendTelegram } from './telegram';
import { sendNtfy } from './ntfy';
import { sendWebhook } from './webhook';
import { sendEmail } from './email';
import type { ChannelMessage } from './types';

const MESSAGE: ChannelMessage = {
  title: 'New low: LHR to JFK $250',
  body: 'LHR to JFK dropped to $250 on United.',
  url: 'https://flights.example/q/abc',
  data: { queryId: 'abc', currentMin: 250, drop: 50, currency: 'USD' },
};

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse() {
  return { ok: true, status: 200, text: async () => '' };
}
function errResponse(status: number, body = 'nope') {
  return { ok: false, status, text: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('sendTelegram', () => {
  it('POSTs to the bot sendMessage endpoint with the chat id and full text', async () => {
    await sendTelegram({ botToken: 'TOKEN', chatId: '42' }, MESSAGE);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('42');
    expect(body.text).toContain('New low: LHR to JFK $250');
    expect(body.text).toContain('https://flights.example/q/abc');
  });

  it('throws with the status when Telegram rejects the request', async () => {
    fetchMock.mockResolvedValue(errResponse(403, 'forbidden'));
    await expect(sendTelegram({ botToken: 'T', chatId: '1' }, MESSAGE)).rejects.toThrow(/403/);
  });

  it('omits the trailing link when the message has no url', async () => {
    await sendTelegram({ botToken: 'T', chatId: '1' }, { ...MESSAGE, url: '' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.text).toBe(`${MESSAGE.title}\n\n${MESSAGE.body}`);
    expect(body.text).not.toContain('http');
  });
});

describe('sendNtfy', () => {
  it('defaults to ntfy.sh and sets the title and click headers', async () => {
    await sendNtfy({ server: '', topic: 'flights' }, MESSAGE);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ntfy.sh/flights');
    expect(init.headers.Title).toBe('New low: LHR to JFK $250');
    expect(init.headers.Click).toBe('https://flights.example/q/abc');
    expect(init.body).toBe(MESSAGE.body);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('targets a custom server and sends a bearer token when configured', async () => {
    await sendNtfy({ server: 'https://ntfy.mybox.dev/', topic: 'deals', token: 'tk_1' }, MESSAGE);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ntfy.mybox.dev/deals');
    expect(init.headers.Authorization).toBe('Bearer tk_1');
  });

  it('omits the Click header when the message has no url', async () => {
    await sendNtfy({ server: '', topic: 'flights' }, { ...MESSAGE, url: '' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Click).toBeUndefined();
  });

  it('rejects redirects on an untrusted custom server so a 307 cannot reach an internal host', async () => {
    // The literal host and its resolved address look public, so the request goes
    // out, but the server could 307/308 to the metadata IP. The redirect target
    // is not re-pinned, so the send must refuse to follow any redirect.
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await sendNtfy({ server: 'https://ntfy.public.dev', topic: 'deals' }, MESSAGE, { trusted: false });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe('error');
  });

  it('treats a redirect response to an internal host as a failure for an untrusted server', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    // fetch with redirect:'error' rejects when the server responds with a redirect.
    fetchMock.mockRejectedValue(new TypeError('unexpected redirect'));
    await expect(
      sendNtfy({ server: 'https://ntfy.public.dev', topic: 'deals' }, MESSAGE, { trusted: false }),
    ).rejects.toThrow();
  });

  it('follows redirects (default) for a trusted custom server', async () => {
    await sendNtfy({ server: 'http://127.0.0.1:8080', topic: 'deals' }, MESSAGE, { trusted: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBeUndefined();
  });

  it('blocks an untrusted (per-user) custom ntfy server on an internal host', async () => {
    await expect(
      sendNtfy({ server: 'http://127.0.0.1:8080', topic: 'deals' }, MESSAGE, { trusted: false }),
    ).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still allows an untrusted channel on the public default ntfy.sh', async () => {
    await sendNtfy({ server: '', topic: 'flights' }, MESSAGE, { trusted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a trusted (admin/global) custom ntfy server on an internal host', async () => {
    await sendNtfy({ server: 'http://127.0.0.1:8080', topic: 'deals' }, MESSAGE, { trusted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sendWebhook', () => {
  it('POSTs the structured payload without a signature when no secret is set', async () => {
    await sendWebhook({ url: 'https://hook.example/x' }, MESSAGE);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hook.example/x');
    const body = JSON.parse(init.body);
    expect(body.data.queryId).toBe('abc');
    expect(body.url).toBe('https://flights.example/q/abc');
    expect(init.headers['X-Signature-256']).toBeUndefined();
  });

  it('signs the exact payload with an HMAC when a secret is set', async () => {
    await sendWebhook({ url: 'https://hook.example/x', secret: 'shh' }, MESSAGE);
    const [, init] = fetchMock.mock.calls[0]!;
    const expected = 'sha256=' + crypto.createHmac('sha256', 'shh').update(init.body).digest('hex');
    expect(init.headers['X-Signature-256']).toBe(expected);
  });

  it.each([
    'http://127.0.0.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://10.1.2.3/hook',
  ])('blocks an untrusted (per-user) webhook aimed at %s and never sends', async (url) => {
    await expect(sendWebhook({ url }, MESSAGE, { trusted: false })).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a trusted (admin/global) webhook to an internal host', async () => {
    await sendWebhook({ url: 'http://127.0.0.1/hook' }, MESSAGE, { trusted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks an untrusted webhook to a public host that embeds credentials', async () => {
    await expect(
      sendWebhook({ url: 'http://user:pass@hook.example/x' }, MESSAGE, { trusted: false }),
    ).rejects.toThrow(/credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks an untrusted webhook whose public hostname resolves to a private address', async () => {
    // The literal-host check passes (hook.example looks public), but DNS resolves
    // it to an internal IP, so the resolve-and-validate step must reject it.
    mockDnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(
      sendWebhook({ url: 'https://hook.example/x' }, MESSAGE, { trusted: false }),
    ).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an untrusted webhook when the public hostname resolves to a public address', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await sendWebhook({ url: 'https://hook.example/x' }, MESSAGE, { trusted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects on an untrusted webhook so a 307 cannot reach an internal host', async () => {
    // hook.example and its resolved address look public, so the request goes out,
    // but the server could 307/308 to localhost or the metadata IP. The redirect
    // target is not re-pinned, so the send must refuse to follow any redirect.
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await sendWebhook({ url: 'https://hook.example/x' }, MESSAGE, { trusted: false });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe('error');
  });

  it('treats a redirect response to an internal host as a failure for an untrusted webhook', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    // fetch with redirect:'error' rejects when the server responds with a redirect.
    fetchMock.mockRejectedValue(new TypeError('unexpected redirect'));
    await expect(
      sendWebhook({ url: 'https://hook.example/x' }, MESSAGE, { trusted: false }),
    ).rejects.toThrow();
  });

  it('follows redirects (default) for a trusted/global webhook', async () => {
    await sendWebhook({ url: 'https://hook.example/x' }, MESSAGE, { trusted: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBeUndefined();
  });
});

describe('sendEmail', () => {
  it('builds an SMTP transport and sends a mail with the alert subject and body', async () => {
    mockSendMail.mockResolvedValue({ messageId: '1' });
    await sendEmail(
      { host: 'smtp.x', port: 587, secure: false, user: 'u', pass: 'p', from: 'a@x', to: 'b@y' },
      MESSAGE,
    );
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.x',
      port: 587,
      secure: false,
      auth: { user: 'u', pass: 'p' },
    });
    const mail = mockSendMail.mock.calls[0]![0];
    expect(mail.to).toBe('b@y');
    expect(mail.from).toBe('a@x');
    expect(mail.subject).toBe(MESSAGE.title);
    expect(mail.text).toContain('https://flights.example/q/abc');
    expect(mail.html).toContain('<a href="https://flights.example/q/abc">');
  });

  it('omits auth when no SMTP user is configured', async () => {
    mockSendMail.mockResolvedValue({ messageId: '2' });
    await sendEmail({ host: 'smtp.x', port: 25, secure: false, from: 'a@x', to: 'b@y' }, MESSAGE);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('omits the link when the message has no url', async () => {
    mockSendMail.mockResolvedValue({ messageId: '3' });
    await sendEmail({ host: 'smtp.x', port: 25, secure: false, from: 'a@x', to: 'b@y' }, { ...MESSAGE, url: '' });
    const mail = mockSendMail.mock.calls[0]![0];
    expect(mail.text).toBe(MESSAGE.body);
    expect(mail.html).not.toContain('<a href');
  });

  it.each(['127.0.0.1', '169.254.169.254', '10.1.2.3'])(
    'blocks an untrusted (per-user) channel using internal SMTP host %s and never sends',
    async (host) => {
      await expect(
        sendEmail({ host, port: 25, secure: false, from: 'a@x', to: 'b@y' }, MESSAGE, { trusted: false }),
      ).rejects.toThrow(/SMTP host is not allowed/);
      expect(mockSendMail).not.toHaveBeenCalled();
    },
  );

  it('allows a trusted (admin/global) channel using an internal SMTP relay', async () => {
    mockSendMail.mockResolvedValue({ messageId: '4' });
    await sendEmail({ host: '127.0.0.1', port: 25, secure: false, from: 'a@x', to: 'b@y' }, MESSAGE, { trusted: true });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('blocks an untrusted channel whose public SMTP host resolves to a private address', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(
      sendEmail({ host: 'smtp.example', port: 587, secure: false, from: 'a@x', to: 'b@y' }, MESSAGE, { trusted: false }),
    ).rejects.toThrow(/SMTP host is not allowed/);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('pins an untrusted channel to the validated IP and keeps the hostname for TLS identity', async () => {
    // Closes the DNS rebinding gap: nodemailer must connect to the address we
    // already validated, not re-resolve the name (which could rebind to an
    // internal IP). The original hostname stays as the TLS servername so cert
    // validation still matches.
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockSendMail.mockResolvedValue({ messageId: '5' });
    await sendEmail(
      { host: 'smtp.example', port: 587, secure: true, from: 'a@x', to: 'b@y' },
      MESSAGE,
      { trusted: false },
    );
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '93.184.216.34',
        tls: { servername: 'smtp.example' },
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('does not pin or override TLS identity for a trusted channel', async () => {
    mockSendMail.mockResolvedValue({ messageId: '6' });
    await sendEmail(
      { host: 'smtp.internal', port: 587, secure: false, from: 'a@x', to: 'b@y' },
      MESSAGE,
      { trusted: true },
    );
    const args = (nodemailer.createTransport as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(args.host).toBe('smtp.internal');
    expect(args.tls).toBeUndefined();
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });
});
