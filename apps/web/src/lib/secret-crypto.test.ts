import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './secret-crypto';

// ADMIN_SESSION_SECRET is provided by src/test/setup.ts, so the scrypt key
// derivation and AES-256-GCM round-trip work without extra wiring.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function encryptWithLegacyKey(plaintext: string): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is required to encrypt stored secrets');
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plaintext secret', () => {
    const plaintext = 'bot-token-12345';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('round-trips unicode and empty strings', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
    expect(decryptSecret(encryptSecret('café ☕ 秘密'))).toBe('café ☕ 秘密');
  });

  it('decrypts a pre-upgrade value encrypted with the legacy SHA-256 key', () => {
    const plaintext = 'legacy-notification-token';
    const legacyEncrypted = encryptWithLegacyKey(plaintext);
    expect(decryptSecret(legacyEncrypted)).toBe(plaintext);
  });

  it('uses a fresh random IV per encryption, so ciphertext differs', () => {
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a).not.toBe(b);
    const ivA = a.split(':')[0];
    const ivB = b.split(':')[0];
    expect(ivA).not.toBe(ivB);
    // 12-byte IV encoded as hex = 24 chars.
    expect(ivA).toHaveLength(24);
    // Both still decrypt back to the same plaintext.
    expect(decryptSecret(a)).toBe('same-input');
    expect(decryptSecret(b)).toBe('same-input');
  });

  it('returns null on a tampered ciphertext (auth-tag check fails)', () => {
    const encrypted = encryptSecret('secret');
    const [iv, tag, ct] = encrypted.split(':');
    // Flip the last byte of the ciphertext.
    const lastByte = parseInt(ct!.slice(-2), 16);
    const flipped = ct!.slice(0, -2) + (lastByte ^ 0xff).toString(16).padStart(2, '0');
    const tampered = `${iv}:${tag}:${flipped}`;
    expect(decryptSecret(tampered)).toBeNull();
  });

  it('returns null on a tampered auth tag', () => {
    const encrypted = encryptSecret('secret');
    const [iv, tag, ct] = encrypted.split(':');
    const lastByte = parseInt(tag!.slice(-2), 16);
    const flippedTag = tag!.slice(0, -2) + (lastByte ^ 0xff).toString(16).padStart(2, '0');
    expect(decryptSecret(`${iv}:${flippedTag}:${ct}`)).toBeNull();
  });

  it('returns null on malformed input rather than throwing', () => {
    expect(decryptSecret('not-encrypted')).toBeNull();
    expect(decryptSecret('only:two')).toBeNull();
    expect(decryptSecret('')).toBeNull();
    expect(decryptSecret('zz:zz:zz')).toBeNull();
  });

  it('returns null when the auth tag is shorter than 16 bytes (truncated tag)', () => {
    const encrypted = encryptSecret('secret');
    const [iv, tag, ct] = encrypted.split(':');
    // Truncate the tag to 8 bytes (16 hex chars). A short tag must be rejected
    // before setAuthTag is called to prevent weakened forgery resistance.
    const shortTag = tag!.slice(0, 16);
    expect(decryptSecret(`${iv}:${shortTag}:${ct}`)).toBeNull();
  });
});
