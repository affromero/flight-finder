import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { createAccessFixture } from "@/test/access-fixture";
const boundary = vi.hoisted(() => ({
  fixture: null as ReturnType<typeof createAccessFixture> | null,
  owner: "",
  unavailable: false,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    sidedoorState: {
      findUnique: async () => {
        if (boundary.unavailable) throw new Error("Database unavailable");
        return { state: await boundary.fixture!.access.store.read() };
      },
    },
    extractionConfig: {
      findUnique: async () => ({ publicBaseUrl: "https://ff.example.com" }),
    },
    user: {
      findFirst: async () => {
        const owner = (
          await boundary.fixture!.access.store.read()
        ).principals.find((principal) => principal.role === "owner");
        return owner ? { id: owner.id } : null;
      },
    },
  },
}));
vi.mock("@/lib/sidedoor/access/service", async () => {
  const { createAccessFixture } = await import("@/test/access-fixture");
  const { DeviceService } = await import("thesidedoor-core/access");
  const { FlightFinderAccessStore } =
    await import("@/lib/sidedoor/access/access-store");
  const fixture = createAccessFixture();
  boundary.fixture = fixture;
  return {
    sharedAccess: fixture.access,
    sharedAccessStore: new FlightFinderAccessStore(),
    sharedDevices: new DeviceService({
      access: fixture.access,
      scopesFor: () => ["api"],
      tokenPrefix: "ff_",
    }),
    sharedProfiles: fixture.profiles,
    SHARED_SESSION_COOKIE: "ft-session",
  };
});

async function run(
  path: string,
  options: {
    token?: string;
    machine?: string;
    method?: string;
    origin?: string;
  } = {},
) {
  const { middleware } = await import("./middleware");
  const headers = new Headers({ host: "ff.example.com" });
  if (options.token) headers.set("cookie", `ft-session=${options.token}`);
  if (options.machine)
    headers.set("authorization", `Bearer ${options.machine}`);
  if (options.origin) headers.set("origin", options.origin);
  return middleware(
    new NextRequest(`https://ff.example.com${path}`, {
      method: options.method,
      headers,
    }),
  );
}
beforeEach(async () => {
  vi.stubEnv("SELF_HOSTED", "true");
  await import("./middleware");
  boundary.fixture!.reset();
  boundary.unavailable = false;
  boundary.owner = await boundary.fixture!.issue("owner", true);
  await boundary.fixture!.access.store.transact((state) => {
    state.initializations.push("flight-finder-platform-v1");
  });
  await boundary.fixture!.access.configureHousehold(
    boundary.owner,
    "household gate password",
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("shared middleware admission", () => {
  it("redirects browsers to access while preserving their destination and answers APIs with 401", async () => {
    const response = await run("/q/example?view=history");
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/access");
    expect(location.searchParams.get("next")).toBe("/q/example?view=history");
    expect((await run("/api/queries")).status).toBe(401);
    expect((await run("/sitemap.xml")).status).toBe(307);
  });
  it("enforces managed policy changes on the next anonymous request", async () => {
    await boundary.fixture!.access.configureHousehold(boundary.owner, null);
    expect((await run("/")).status).toBe(200);
    await boundary.fixture!.access.configureHousehold(
      boundary.owner,
      "replacement gate password",
    );
    expect((await run("/")).status).toBe(307);
  });
  it("accepts persisted household admission until revoked without granting owner authority", async () => {
    const token = await boundary.fixture!.access.enterHousehold(
      "household gate password",
    );
    expect((await run("/q/example", { token })).status).toBe(200);
    expect((await run("/api/admin/config", { token })).status).toBe(403);
    await boundary.fixture!.access.logout(token);
    expect((await run("/api/queries", { token })).status).toBe(401);
  });
  it("keeps paired device admission separate from owner authority", async () => {
    const { DeviceService } = await import("thesidedoor-core/access");
    const sharedDevices = new DeviceService({
      access: boundary.fixture!.access,
      scopesFor: () => ["api"],
      tokenPrefix: "ff_",
    });
    const owner = (await boundary.fixture!.access.authenticate(boundary.owner))
      .principal!;
    const token = await sharedDevices.issueForOperator(
      owner.id,
      ["api"],
      "Test automation",
    );
    expect((await run("/api/queries", { machine: token })).status).toBe(200);
    expect((await run("/api/admin/config", { machine: token })).status).toBe(
      401,
    );
    expect((await run("/api/queries", { machine: "wrong" })).status).toBe(401);
  });
  it("checks the origin of authenticated mutations", async () => {
    expect(
      (
        await run("/api/admin/config", {
          token: boundary.owner,
          method: "PATCH",
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await run("/api/admin/config", {
          token: boundary.owner,
          method: "PATCH",
          origin: "https://ff.example.com",
        })
      ).status,
    ).toBe(200);
  });
  it("fails closed when admission policy is unavailable", async () => {
    boundary.unavailable = true;
    expect((await run("/api/queries")).status).toBe(503);
    expect((await run("/api/health")).status).toBe(200);
  });
  it.each([
    "/access",
    "/api/access/login",
    "/api/health",
    "/api/version",
    "/api/cron/scrape",
    "/api/community/ingest",
    "/api/analytics/track",
    "/sw.js",
    "/manifest.json",
    "/icon-192.png",
    "/robots.txt",
  ])(
    "preserves independently authorized or public endpoint %s",
    async (path) => {
      expect((await run(path)).status).toBe(200);
    },
  );
});
