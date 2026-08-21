import { NextRequest, NextResponse } from 'next/server';
import { classifyBot, classifyByHeaders, isMaliciousPath } from '@/lib/analytics/bots';
import {
  GATE_COOKIE,
  gateEnabled,
  verifyMachineToken,
  verifySessionToken,
} from '@/lib/access/gate';

// "ft-" prefix kept across the Flight Finder rename so existing sessions survive.
// Mirrors SESSION_COOKIE in lib/admin-auth.ts. The two are kept separate on
// purpose: this file runs on the Edge runtime and cannot import admin-auth,
// which pulls in next/headers and the Node crypto module (neither is Edge
// safe). Keep both literals in sync if the cookie name ever changes.
const SESSION_COOKIE = 'ft-session';
// Server-side expiry bound, in seconds. Mirrors SESSION_MAX_AGE in
// lib/admin-auth.ts and the cookie maxAge (7 days). Tokens older than this are
// rejected even when the HMAC is valid, so a stale or stolen cookie cannot be
// replayed indefinitely.
const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 7 * 1000;
const isSelfHosted = process.env.SELF_HOSTED === 'true';

// Edge-safe HMAC + expiry check for the admin session cookie. The signature
// algorithm matches lib/admin-auth.ts verifySessionToken, but is reimplemented
// with crypto.subtle here because the Node crypto module is not available on
// the Edge runtime where middleware executes.
async function verifyHmacToken(token: string): Promise<boolean> {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return false;

  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;

  const payload = token.slice(0, lastDot);
  // Edge middleware gates admin paths only. Reject non-admin payloads
  // (e.g. user:<id>:<ts>) so a token issued for a household member in
  // self-hosted multi user mode can't be replayed as admin against a
  // hosted deployment that happens to share ADMIN_SESSION_SECRET.
  if (!payload.startsWith('admin:')) return false;

  // Server-side expiry: reject tokens older than the cookie maxAge before
  // spending a crypto.subtle verify on them.
  const ts = Number(payload.slice('admin:'.length));
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > SESSION_MAX_AGE_MS) return false;

  const sig = token.slice(lastDot + 1);

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const expected = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (sig.length !== expected.length) return false;
    let result = 0;
    for (let i = 0; i < sig.length; i++) {
      result |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return result === 0;
  } catch {
    return false;
  }
}

/**
 * Paths that stay reachable on a gated instance.
 *
 * Each one is here because something that is not a logged-in browser depends on
 * it: the container healthcheck, the deploy's version probe, the gate's own
 * login round-trip, callers that carry their own credential (cron with
 * CRON_SECRET, community sync with a bearer key, the middleware's internal
 * analytics POST), and the assets a browser fetches without cookies — the
 * service worker, the manifest, icons and the OG image, or the login page
 * renders bare and the PWA silently stops updating.
 *
 * `/sitemap.xml` is deliberately absent: it enumerates active query IDs, which
 * is exactly what a private instance must not publish. `/robots.txt` is present
 * but answers Disallow when the gate is on.
 */
const GATE_EXEMPT_EXACT = new Set([
  '/api/health',
  '/api/version',
  '/api/gate',
  '/api/analytics/track',
  '/api/cron/scrape',
  '/api/community/register',
  '/api/community/ingest',
  '/sw.js',
  '/manifest.json',
  '/robots.txt',
  '/og-hero.png',
  '/og-hero.svg',
  '/apple-icon.png',
]);

function isGateExempt(pathname: string): boolean {
  if (pathname === '/gate') return true;
  if (GATE_EXEMPT_EXACT.has(pathname)) return true;
  // Icon variants (icon-192.png, icon-512-maskable.png, …) are fetched without
  // cookies; a gated icon makes the browser fall back to another site's favicon.
  if (pathname.startsWith('/icon-')) return true;
  return false;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Block .php requests — always bot probes
  if (pathname.endsWith('.php')) {
    return new NextResponse(null, { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
  }

  // Block malicious paths (WordPress probes, .env, etc.)
  if (isMaliciousPath(pathname)) {
    return new NextResponse(null, { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
  }

  // --- Instance access gate (private deployments only) ---
  // Runs before admin auth: on a gated instance nothing should be reachable
  // without a credential, including the admin login page itself. This is not
  // authentication — admin auth below still applies to whoever gets through.
  if (gateEnabled() && !isGateExempt(pathname)) {
    const admitted =
      (await verifySessionToken(request.cookies.get(GATE_COOKIE)?.value)) ||
      (await verifyMachineToken(request.headers.get('authorization')));
    if (!admitted) {
      // Non-browser callers get a status they can act on; a browser gets the
      // gate, with where it was heading so the round-trip is not a dead end.
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ ok: false, error: 'Locked' }, { status: 401 });
      }
      const gate = new URL('/gate', request.url);
      const target = `${pathname}${request.nextUrl.search}`;
      if (target !== '/') gate.searchParams.set('next', target);
      return NextResponse.redirect(gate);
    }
  }

  // Self-hosted: no login page, redirect straight to dashboard
  if (isSelfHosted && pathname.startsWith('/admin/login')) {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  // Admin auth — skip entirely for self-hosted (no admin panel)
  if (!isSelfHosted) {
    // Admin pages (not login) — require session
    if (pathname.startsWith('/admin') && !pathname.startsWith('/admin/login')) {
      const token = request.cookies.get(SESSION_COOKIE)?.value;
      if (!token || !(await verifyHmacToken(token))) {
        return NextResponse.redirect(new URL('/admin/login', request.url));
      }
    }

    // Admin API routes — require session
    if (pathname.startsWith('/api/admin') && !pathname.startsWith('/api/admin/auth')) {
      const token = request.cookies.get(SESSION_COOKIE)?.value;
      if (!token || !(await verifyHmacToken(token))) {
        return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }
  }

  // --- Analytics tracking (flight-finder.org only) ---
  const userAgent = request.headers.get('user-agent') || '';

  // Skip tracking for self-hosted, admin pages, API routes, empty UAs
  if (!isSelfHosted && !pathname.startsWith('/admin') && !pathname.startsWith('/api/') && userAgent) {
    // When TRUSTED_FORWARDED_FOR=false there is no trusted proxy, so the
    // x-forwarded-for header is attacker-controllable. Collapse to a constant
    // rather than letting callers mint arbitrary analytics IP buckets.
    // Mirrors the same guard in lib/trusted-ip.ts (which cannot be imported
    // here because the Edge runtime does not support all Node.js modules).
    const ip = process.env.TRUSTED_FORWARDED_FOR === 'false'
      ? 'unknown'
      : (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         request.headers.get('x-real-ip') ||
         '127.0.0.1');

    // Classify bot: UA match → 3, missing browser headers → 2, default → 1
    const bot = classifyBot(userAgent);
    let botScore = 1;
    if (bot.isBot) {
      botScore = 3;
    } else {
      const headerScore = classifyByHeaders(request.headers);
      if (headerScore > 0) botScore = headerScore;
    }

    // Extract referrer (only external)
    const refHeader = request.headers.get('referer') || '';
    let referrer: string | undefined;
    try {
      if (refHeader) {
        const refUrl = new URL(refHeader);
        const reqHost = request.nextUrl.host;
        if (refUrl.host !== reqHost) {
          referrer = refHeader;
        }
      }
    } catch {
      // Invalid referrer URL — ignore
    }

    // Fire-and-forget to internal tracking API (avoids importing Node.js-only
    // modules here). The shared secret proves the call originates from the
    // middleware so the public route can reject direct internet writes while
    // still trusting the real client IP and bot score we computed above.
    const trackUrl = new URL('/api/analytics/track', request.url);
    fetch(trackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.ADMIN_SESSION_SECRET ?? '',
      },
      body: JSON.stringify({ path: pathname, ip, userAgent, referrer, botScore }),
    }).catch(() => {});
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg).*)'],
};
