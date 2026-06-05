import { describe, it, expect } from 'vitest';
import { encryptSecret } from '@/lib/secret-crypto';
import {
  validateChannelConfig,
  encryptChannelConfig,
  decryptChannelConfig,
  mergeStoredConfig,
  assertPublicUrl,
  assertPublicHost,
  SECRET_FIELDS,
} from './config';

// ADMIN_SESSION_SECRET is provided by src/test/setup.ts, so the AES round-trip works.

describe('validateChannelConfig', () => {
  it('accepts a complete telegram config', () => {
    expect(validateChannelConfig('telegram', { botToken: 'abc', chatId: '123' })).toEqual({
      botToken: 'abc',
      chatId: '123',
    });
  });

  it('rejects a telegram config missing a required field', () => {
    expect(() => validateChannelConfig('telegram', { botToken: 'abc' })).toThrow(/chatId/);
  });

  it('defaults the ntfy server when omitted', () => {
    const cfg = validateChannelConfig('ntfy', { topic: 'flights' });
    expect(cfg.server).toBe('https://ntfy.sh');
    expect(cfg.token).toBeUndefined();
  });

  it('rejects an email config with an out-of-range port', () => {
    expect(() =>
      validateChannelConfig('email', { host: 'smtp.x', port: 70000, from: 'a@x', to: 'b@y' }),
    ).toThrow(/port/);
  });

  it('coerces a string email port and reads secure as a strict boolean', () => {
    const cfg = validateChannelConfig('email', {
      host: 'smtp.x',
      port: '587',
      secure: 'yes',
      from: 'a@x',
      to: 'b@y',
    });
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false); // only literal true enables TLS
  });

  it('rejects a non-object config', () => {
    expect(() => validateChannelConfig('webhook', 'http://x')).toThrow(/object/);
  });
});

describe('encrypt/decrypt channel config', () => {
  it('encrypts only the secret fields and round-trips back to plaintext', () => {
    const plain = { botToken: 'super-secret-token', chatId: '999' };
    const stored = encryptChannelConfig('telegram', plain);

    // Secret field is encrypted; non-secret field is untouched.
    expect(stored.botToken).not.toBe('super-secret-token');
    expect(String(stored.botToken)).toContain(':'); // iv:tag:ciphertext
    expect(stored.chatId).toBe('999');

    const back = decryptChannelConfig('telegram', stored);
    expect(back).toEqual(plain);
  });

  it('declares exactly the sensitive fields as secret', () => {
    expect(SECRET_FIELDS).toEqual({
      telegram: ['botToken'],
      email: ['pass'],
      ntfy: ['token'],
      webhook: ['secret'],
    });
  });
});

describe('mergeStoredConfig — clearing optional secrets', () => {
  it('clears an optional secret when the field is explicitly null', () => {
    const existing = { url: 'https://hook.example', secret: encryptSecret('shh') };
    const merged = mergeStoredConfig('webhook', existing, { url: 'https://hook.example', secret: null });
    expect(merged.secret).toBeUndefined();
    expect(merged.url).toBe('https://hook.example');
  });

  it('keeps an existing secret when the field is blank/absent', () => {
    const enc = encryptSecret('shh');
    const merged = mergeStoredConfig('webhook', { url: 'https://hook.example', secret: enc }, { url: 'https://hook.example' });
    expect(merged.secret).toBe(enc);
  });

  it('refuses to clear a required secret (validation fails)', () => {
    const existing = { botToken: encryptSecret('tok'), chatId: '1' };
    expect(() => mergeStoredConfig('telegram', existing, { botToken: null })).toThrow();
  });
});

describe('assertPublicUrl', () => {
  it('allows a public https url for an untrusted owner', () => {
    expect(() => assertPublicUrl('https://example.com/hook', { trusted: false })).not.toThrow();
  });

  it.each([
    'http://localhost/hook',
    'http://127.0.0.1/hook',
    'http://10.1.2.3/hook',
    'http://192.168.0.5/hook',
    'http://172.16.9.9/hook',
    'http://169.254.169.254/latest/meta-data', // cloud metadata
    'http://[::1]/hook',
    'http://[::ffff:127.0.0.1]/hook', // IPv4-mapped IPv6, dotted
    'http://[::ffff:7f00:1]/hook', // IPv4-mapped IPv6, hex form (127.0.0.1)
    'http://999.10.0.1/hook', // malformed numeric host
  ])('blocks internal address %s for an untrusted owner', (url) => {
    expect(() => assertPublicUrl(url, { trusted: false })).toThrow();
  });

  it('allows internal addresses for a trusted (admin/global) owner', () => {
    expect(() => assertPublicUrl('http://localhost:11434/hook', { trusted: true })).not.toThrow();
  });

  it('rejects non-http(s) schemes and credentials in the url', () => {
    expect(() => assertPublicUrl('ftp://example.com', { trusted: true })).toThrow(/http/);
    expect(() => assertPublicUrl('https://user:pass@example.com', { trusted: true })).toThrow(/credentials/);
  });
});

describe('assertPublicHost (SMTP)', () => {
  it('allows a public host for an untrusted owner', () => {
    expect(() => assertPublicHost('smtp.example.com', { trusted: false })).not.toThrow();
  });

  it.each(['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '169.254.169.254', '::1'])(
    'blocks internal SMTP host %s for an untrusted owner',
    (host) => {
      expect(() => assertPublicHost(host, { trusted: false })).toThrow(/not allowed/);
    },
  );

  it('allows internal SMTP hosts for a trusted (admin/global) owner', () => {
    expect(() => assertPublicHost('127.0.0.1', { trusted: true })).not.toThrow();
  });

  it('rejects a blank host', () => {
    expect(() => assertPublicHost('', { trusted: true })).toThrow(/required/);
  });
});
