import { scrypt, randomBytes, timingSafeEqual } from 'crypto';

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;

// Current cost parameters. N=32768 doubles the work factor over the Node
// default (16384) at r=8,p=1. The stored format is `salt:key` (two hex parts)
// and does not encode the cost, so verify tries the current parameters first
// and falls back to the legacy default cost for hashes minted before the raise.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

// Cost parameters used by hashes minted before N was raised (Node scrypt
// defaults). Kept so existing stored hashes still verify.
const LEGACY_N = 16384;
const LEGACY_R = 8;
const LEGACY_P = 1;

interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

function derive(password: string, salt: string, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must comfortably exceed 128 * N * r bytes for scrypt to run.
    const maxmem = 256 * cost.N * cost.r;
    scrypt(password, salt, KEY_LENGTH, { N: cost.N, r: cost.r, p: cost.p, maxmem }, (err, derived) => {
      if (err) return reject(err);
      resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const derived = await derive(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyHashedPassword(password: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(':');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'hex');

  // Try the current cost first, then the legacy default cost. Each comparison
  // is constant-time; the fallback covers hashes minted before the raise.
  for (const cost of [
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    { N: LEGACY_N, r: LEGACY_R, p: LEGACY_P },
  ]) {
    let derived: Buffer;
    try {
      derived = await derive(password, salt, cost);
    } catch {
      continue;
    }
    try {
      if (timingSafeEqual(expected, derived)) return true;
    } catch {
      return false;
    }
  }
  return false;
}
