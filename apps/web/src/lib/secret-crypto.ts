import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
// AES-GCM authentication tag must be exactly 16 bytes (128 bits) to guarantee
// full forgery resistance. Shorter tags accepted by Node's setAuthTag would
// reduce the security margin; reject them before decryption begins.
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Fixed application salt and domain-separation label for key derivation. These
// are intentionally constant (not secret): scrypt stretches the secret and the
// label scopes the derived key to this single purpose (secrets at rest), so the
// same ADMIN_SESSION_SECRET cannot collide with keys derived for other uses.
const KDF_SALT = Buffer.from('flight-finder.secret-crypto.v1', 'utf8');
const KDF_LABEL = 'aes-256-gcm:secret-at-rest';
// scrypt cost parameters. N=32768 raises the work factor well above the Node
// default (16384) at r=8,p=1.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function getKey(): Buffer {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is required to encrypt stored secrets');
  // Bind the label to the input so the KDF is domain-separated from any other
  // derivation that might reuse ADMIN_SESSION_SECRET.
  // maxmem must comfortably exceed 128 * N * r bytes (32 MB at these params),
  // which is above the Node default, so set it explicitly.
  return crypto.scryptSync(`${KDF_LABEL}:${secret}`, KDF_SALT, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });
}

function getLegacyKey(): Buffer {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is required to encrypt stored secrets');
  return crypto.createHash('sha256').update(secret).digest();
}

function decryptWithKey(key: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Encrypt a plaintext secret at rest. Returns hex-encoded iv:tag:ciphertext. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a hex-encoded iv:tag:ciphertext string produced by encryptSecret.
 * Returns null on any failure (malformed input, wrong key, or a failed auth-tag
 * check) so callers never crash on tampered ciphertext. Legacy values encrypted
 * under the old SHA-256 key derivation decrypt through a fallback without
 * requiring user re-entry.
 */
export function decryptSecret(encoded: string): string | null {
  const parts = encoded.split(':');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0]!, 'hex');
    const tag = Buffer.from(parts[1]!, 'hex');
    const encrypted = Buffer.from(parts[2]!, 'hex');
    if (iv.length !== IV_LENGTH) return null;
    if (tag.length !== TAG_LENGTH) return null;
    try {
      return decryptWithKey(getKey(), iv, tag, encrypted);
    } catch {
      // encryptSecret always writes the current scrypt format, so legacy
      // ciphertext is lazily migrated the next time an admin saves it.
      return decryptWithKey(getLegacyKey(), iv, tag, encrypted);
    }
  } catch {
    return null;
  }
}
