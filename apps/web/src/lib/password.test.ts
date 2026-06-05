import { describe, it, expect } from 'vitest';
import { scrypt } from 'crypto';
import { promisify } from 'util';
import { hashPassword, verifyHashedPassword } from './password';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Recreate a hash exactly as the pre-hardening code did: scrypt with the Node
// default cost (N=16384) and the same salt:key encoding. Used to prove existing
// stored hashes still verify after the cost was raised.
async function legacyHash(password: string): Promise<string> {
  const salt = 'a'.repeat(32);
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 });
  return `${salt}:${key.toString('hex')}`;
}

describe('hashPassword', () => {
  it('produces salt:hex format', async () => {
    const hash = await hashPassword('test-password');
    // 16-byte salt = 32 hex chars, 64-byte key = 128 hex chars
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it('produces unique salts per call', async () => {
    const hash1 = await hashPassword('same-password');
    const hash2 = await hashPassword('same-password');
    const salt1 = hash1.split(':')[0];
    const salt2 = hash2.split(':')[0];
    expect(salt1).not.toBe(salt2);
  });

  it('derives the key at the raised cost (N=32768), not the legacy default', async () => {
    // Same password + salt under the raised cost must differ from the
    // legacy-cost derivation, proving the work factor was actually raised.
    const salt = '00112233445566778899aabbccddeeff';
    const raised = (
      await scryptAsync('pw', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 256 * 32768 * 8 })
    ).toString('hex');
    const legacy = (
      await scryptAsync('pw', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 })
    ).toString('hex');
    expect(raised).not.toBe(legacy);
    // A freshly minted hash verifies under the current parameters.
    const fresh = await hashPassword('pw');
    expect(await verifyHashedPassword('pw', fresh)).toBe(true);
  });
});

describe('verifyHashedPassword', () => {
  it('accepts correct password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyHashedPassword('correct-horse', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyHashedPassword('wrong-horse', hash)).toBe(false);
  });

  it('still verifies a legacy default-cost (N=16384) hash', async () => {
    // Existing stored hashes were minted at the Node default cost. Raising the
    // cost must not lock those users out.
    const oldHash = await legacyHash('legacy-password');
    expect(await verifyHashedPassword('legacy-password', oldHash)).toBe(true);
  });

  it('rejects a wrong password against a legacy default-cost hash', async () => {
    const oldHash = await legacyHash('legacy-password');
    expect(await verifyHashedPassword('not-the-password', oldHash)).toBe(false);
  });

  it('rejects malformed hash without colon', async () => {
    expect(await verifyHashedPassword('anything', 'nocolon')).toBe(false);
  });

  it('rejects empty hash', async () => {
    expect(await verifyHashedPassword('anything', '')).toBe(false);
  });

  it('rejects hash with wrong-length key', async () => {
    // timingSafeEqual throws on length mismatch, caught → false
    expect(await verifyHashedPassword('anything', 'ab:cd')).toBe(false);
  });
});
