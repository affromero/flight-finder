import { createAccessHandler } from "thesidedoor-core/access/http";
import { DeviceService } from "thesidedoor-core/access";
import { prisma } from "@/lib/prisma";
import { sharedAccess, sharedProfiles, SHARED_SESSION_COOKIE } from "./service";

const devices = new DeviceService({
  access: sharedAccess,
  scopesFor: () => ["api"],
  tokenPrefix: "ff_",
});

export async function accessHandler() {
  const config = await prisma.extractionConfig.findUnique({
    where: { id: "singleton" },
    select: { publicBaseUrl: true },
  });
  const configured: unknown = process.env.SIDEDOOR_PASSWORD_ORIGINS
    ? JSON.parse(process.env.SIDEDOOR_PASSWORD_ORIGINS)
    : [];
  if (
    !Array.isArray(configured) ||
    !configured.every((value) => typeof value === "string")
  )
    throw new Error(
      "SIDEDOOR_PASSWORD_ORIGINS must be a JSON array of explicit origins",
    );
  return createAccessHandler({
    access: sharedAccess,
    devices,
    profiles: sharedProfiles,
    name: "Flight Finder",
    origin:
      config?.publicBaseUrl || process.env.APP_URL || "http://localhost:3003",
    passwordOrigins: configured,
    trustedProxy: process.env.SIDEDOOR_TRUSTED_PROXY === "true",
    useHostHeader: true,
    cookieName: SHARED_SESSION_COOKIE,
  });
}
