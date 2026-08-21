/**
 * Instance access gate for a privately exposed deployment.
 *
 * The public site is open to everyone; a private instance sets
 * FF_ACCESS_PASSWORD and this gate stands in front of everything that is not
 * explicitly exempt. Getting past it is not authentication — the existing admin
 * login still guards /admin and /api/admin. It only decides who may see the
 * instance at all.
 *
 * Two ways in: the shared password, or an invite link an admin generated (which
 * a phone scans as a QR code). Both produce the same session cookie, and the
 * invite is exchanged for one immediately so a token never lingers in browser
 * history, logs, or a referrer header.
 *
 * The signing key is derived from the password itself, so there is no second
 * secret to distribute or keep in sync — and changing the password revokes every
 * outstanding cookie and unused invite, which is what an operator expects a
 * password change to do. Deliberately NOT derived from ADMIN_SESSION_SECRET:
 * that value also decrypts stored provider keys, so coupling the two would mean
 * a gate rotation silently destroys saved credentials.
 *
 * Implemented on Web Crypto only, so Edge middleware and Node route handlers
 * share one implementation.
 */

export const GATE_COOKIE = 'ff-gate';

/** How long a browser stays admitted before it must present a credential again. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Invite links are meant to be used on receipt, not saved. */
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** Short enough to type on a phone, long enough that a key derived from it holds up. */
const MIN_PASSWORD_LENGTH = 16;

type Scope = 'session' | 'invite';

const encoder = new TextEncoder();

export function accessPasswordConfigured(): boolean {
  return Boolean(process.env.FF_ACCESS_PASSWORD);
}

export function accessPasswordMeetsSecurityPolicy(): boolean {
  return (process.env.FF_ACCESS_PASSWORD?.length ?? 0) >= MIN_PASSWORD_LENGTH;
}

/** The gate is inert unless a password long enough to derive a key from is set. */
export function gateEnabled(): boolean {
  return accessPasswordConfigured() && accessPasswordMeetsSecurityPolicy();
}

async function digestHex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time hex comparison (both inputs are fixed-length digests). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyAccessPassword(password: string): Promise<boolean> {
  const configured = process.env.FF_ACCESS_PASSWORD;
  if (!configured || !accessPasswordMeetsSecurityPolicy()) return false;
  return constantTimeEqual(await digestHex(password), await digestHex(configured));
}

async function signingKey(): Promise<CryptoKey | null> {
  const material = process.env.FF_ACCESS_PASSWORD;
  if (!material || !accessPasswordMeetsSecurityPolicy()) return null;
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`${material}:flight-finder-access-gate`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signPayload(payload: string): Promise<string | null> {
  const key = await signingKey();
  if (!key) return null;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `<scope>.<expiry>.<signature>` — the scope is inside the signed payload AND
 * checked on the way out, so an invite cannot be replayed as a session cookie
 * and a session cookie cannot be handed out as an invite link.
 */
async function createToken(scope: Scope, ttlMs: number): Promise<string | null> {
  const expiry = Date.now() + ttlMs;
  const sig = await signPayload(`${scope}.${expiry}`);
  return sig ? `${scope}.${expiry}.${sig}` : null;
}

async function verifyToken(scope: Scope, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokenScope, rawExpiry, sig] = parts as [string, string, string];
  if (tokenScope !== scope) return false;
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = await signPayload(`${scope}.${expiry}`);
  return expected !== null && constantTimeEqual(sig, expected);
}

export const createSessionToken = () => createToken('session', SESSION_TTL_MS);
export const verifySessionToken = (token: string | undefined) => verifyToken('session', token);
export const createInviteToken = () => createToken('invite', INVITE_TTL_MS);
export const verifyInviteToken = (token: string | undefined) => verifyToken('invite', token);

/**
 * A non-browser caller (the CLI, a script) presents this instead of a cookie.
 * Separate from the gate password so it can be rotated on its own, and compared
 * through a digest so the check does not leak length or an early-exit timing
 * difference.
 */
export async function verifyMachineToken(header: string | null): Promise<boolean> {
  const configured = process.env.FF_MACHINE_TOKEN;
  if (!configured || configured.length < MIN_PASSWORD_LENGTH) return false;
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!presented) return false;
  return constantTimeEqual(await digestHex(presented), await digestHex(configured));
}

export function gateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
