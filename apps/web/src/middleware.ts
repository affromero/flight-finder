import { NextRequest, NextResponse } from 'next/server';
import { classifyBot, classifyByHeaders, isMaliciousPath } from '@/lib/analytics/bots';

// "ft-" prefix kept across the Flight Finder rename so existing sessions survive.
const SESSION_COOKIE = 'ft-session';
const isSelfHosted = process.env.SELF_HOSTED === 'true';

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
    const forwardedFor = request.headers.get('x-forwarded-for');
    const ip = forwardedFor?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || '127.0.0.1';

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

    // Fire-and-forget to internal tracking API (avoids importing Node.js-only modules)
    const trackUrl = new URL('/api/analytics/track', request.url);
    fetch(trackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathname, ip, userAgent, referrer, botScore }),
    }).catch(() => {});
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg).*)'],
};
