import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './secret-crypto';

// ADMIN_SESSION_SECRET is provided by src/test/setup.ts, so the scrypt key
// derivation and AES-256-GCM round-trip work without extra wiring.

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
    // Truncate the tag to 8 bytes (16 hex chars) -- a short tag must be rejected
    // before setAuthTag is called to prevent weakened forgery resistance.
    const shortTag = tag!.slice(0, 16);
    expect(decryptSecret(`${iv}:${shortTag}:${ct}`)).toBeNull();
  });

  it('returns null for a legacy SHA-256-key ciphertext (re-entry required)', () => {
    // A well-formed iv:tag:ciphertext that was never produced by the current
    // scrypt key decrypts to null because the auth tag will not verify under
    // the new key. Simulated here with a structurally valid but foreign value.
    const legacy = `${'a'.repeat(24)}:${'b'.repeat(32)}:${'c'.repeat(16)}`;
    expect(decryptSecret(legacy)).toBeNull();
  });
});
