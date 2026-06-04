import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const mockSendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mockSendMail })) },
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
});
