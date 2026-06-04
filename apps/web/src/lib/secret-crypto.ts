import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is required to encrypt stored secrets');
  return crypto.createHash('sha256').update(secret).digest();
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

/** Decrypt a hex-encoded iv:tag:ciphertext string produced by encryptSecret. */
export function decryptSecret(encoded: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret format');
  const iv = Buffer.from(parts[0]!, 'hex');
  const tag = Buffer.from(parts[1]!, 'hex');
  const encrypted = Buffer.from(parts[2]!, 'hex');
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
