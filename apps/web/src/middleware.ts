import { NextRequest, NextResponse } from "next/server";
import {
  classifyBot,
  classifyByHeaders,
  isMaliciousPath,
} from "@/lib/analytics/bots";
import {
  sharedAccess,
  sharedAccessStore,
  SHARED_SESSION_COOKIE,
} from "@/lib/sidedoor/access/service";
import { DeviceService, isAccessError } from "thesidedoor-core/access";
import { accessHandler } from "@/lib/sidedoor/access/access";

const isSelfHosted = process.env.SELF_HOSTED === "true";
const sharedDevices = new DeviceService({
  access: sharedAccess,
  scopesFor: () => ["api"],
  tokenPrefix: "ff_",
});
const GATE_EXEMPT_EXACT = new Set([
  "/api/health",
  "/api/version",
  "/api/analytics/track",
  "/api/cron/scrape",
  "/api/community/register",
  "/api/community/ingest",
  "/api/auth/login",
  "/api/auth/logout",
  "/sw.js",
  "/manifest.json",
  "/robots.txt",
  "/og-hero.png",
  "/og-hero.svg",
  "/apple-icon.png",
]);
function isGateExempt(pathname: string): boolean {
  return (
    pathname === "/access" ||
    pathname.startsWith("/access/") ||
    pathname.startsWith("/api/access/") ||
    GATE_EXEMPT_EXACT.has(pathname) ||
    pathname.startsWith("/icon-")
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/api/") &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method)
  ) {
    const origin = request.headers.get("origin");
    const forwardedProtocol =
      process.env.TRUSTED_FORWARDED_FOR !== "false"
        ? request.headers.get("x-forwarded-proto")
        : null;
    const protocol =
      forwardedProtocol === "https" || forwardedProtocol === "http"
        ? `${forwardedProtocol}:`
        : request.nextUrl.protocol;
    const expectedOrigin = `${protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin !== null && origin !== expectedOrigin)
    )
      return NextResponse.json(
        { ok: false, error: "Cross-origin changes are not allowed" },
        { status: 403 },
      );
  }

  if (pathname.endsWith(".php") || isMaliciousPath(pathname))
    return new NextResponse(null, {
      status: 404,
      headers: { "X-Robots-Tag": "noindex" },
    });

  if (!isGateExempt(pathname)) {
    try {
      const policy = await sharedAccessStore.admissionPolicy();
      const { hasOwner } = policy;
      const token = request.cookies.get(SHARED_SESSION_COOKIE)?.value;
      let auth: ReturnType<typeof sharedAccess.sessionFromState> | null = null;
      if (token) {
        try {
          auth = await sharedAccess.authenticate(token);
        } catch (error) {
          if (!isAccessError(error) || error.code !== "unauthorized")
            throw error;
        }
      }
      const bearer = request.headers.get("authorization");
      let device = false;
      if (bearer?.startsWith("Bearer ")) {
        try {
          await sharedDevices.authenticate(bearer.slice("Bearer ".length), [
            "api",
          ]);
          device = true;
        } catch (error) {
          if (
            !isAccessError(error) ||
            !["unauthorized", "forbidden"].includes(error.code)
          )
            throw error;
        }
      }
      const ownerRoute =
        pathname.startsWith("/admin") ||
        pathname.startsWith("/api/admin/") ||
        pathname === "/setup" ||
        pathname === "/api/setup" ||
        (pathname.startsWith("/api/setup/") &&
          pathname !== "/api/setup/status");
      let ownerAccess = false;
      if (ownerRoute && auth && token) {
        try {
          await sharedAccess.authenticate(token, true);
          ownerAccess = true;
        } catch (error) {
          if (!isAccessError(error) || error.code !== "forbidden") throw error;
        }
      }
      if (ownerRoute && !ownerAccess) {
        if (pathname.startsWith("/api/"))
          return NextResponse.json(
            { ok: false, error: auth ? "Forbidden" : "Unauthorized" },
            { status: auth ? 403 : 401 },
          );
        const destination = new URL("/access", request.url);
        destination.searchParams.set("next", pathname + request.nextUrl.search);
        if (!hasOwner) destination.searchParams.set("mode", "claim");
        return NextResponse.redirect(destination);
      }
      const privateInstance =
        policy.passwordRequired ||
        policy.mode === "individual" ||
        (isSelfHosted && !hasOwner);
      if (privateInstance && !auth && !device) {
        if (pathname.startsWith("/api/"))
          return NextResponse.json(
            { ok: false, error: "Locked" },
            { status: 401 },
          );
        const destination = new URL("/access", request.url);
        destination.searchParams.set("next", pathname + request.nextUrl.search);
        destination.searchParams.set(
          "mode",
          hasOwner
            ? policy.mode === "household"
              ? "household"
              : "login"
            : "claim",
        );
        return NextResponse.redirect(destination);
      }
      if (auth && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const headers = new Headers(request.headers);
        headers.set("content-type", "application/json");
        headers.delete("content-length");
        const check = await (
          await accessHandler()
        )(
          new Request(request.url, {
            method: "POST",
            headers,
            body: "{}",
            signal: request.signal,
          }),
          ownerRoute ? "authorize-owner" : "authorize-session",
        );
        if (!check.ok)
          return new NextResponse(await check.text(), {
            status: check.status,
            headers: check.headers,
          });
      }
    } catch {
      return NextResponse.json(
        { ok: false, error: "Access state is unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // --- Analytics tracking (flight-finder.org only) ---
  const userAgent = request.headers.get("user-agent") || "";

  // Skip tracking for self-hosted, admin pages, API routes, empty UAs
  if (
    !isSelfHosted &&
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/api/") &&
    userAgent
  ) {
    // When TRUSTED_FORWARDED_FOR=false there is no trusted proxy, so the
    // x-forwarded-for header is attacker-controllable. Collapse to a constant
    // rather than letting callers mint arbitrary analytics IP buckets.
    // Mirrors the same guard in lib/trusted-ip.ts (which cannot be imported
    // here because the Edge runtime does not support all Node.js modules).
    const ip =
      process.env.TRUSTED_FORWARDED_FOR === "false"
        ? "unknown"
        : request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          "127.0.0.1";

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
    const refHeader = request.headers.get("referer") || "";
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
    const trackUrl = new URL("/api/analytics/track", request.url);
    fetch(trackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": process.env.ADMIN_SESSION_SECRET ?? "",
      },
      body: JSON.stringify({
        path: pathname,
        ip,
        userAgent,
        referrer,
        botScore,
      }),
    }).catch(() => {});
  }

  return NextResponse.next();
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg).*)"],
};
