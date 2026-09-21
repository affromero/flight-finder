import type { MetadataRoute } from "next";
import { sharedAccessStore } from "@/lib/sidedoor/access/service";

export default async function robots(): Promise<MetadataRoute.Robots> {
  // A gated instance is private: say so plainly rather than advertising routes
  // no crawler can reach anyway, and do not point at the public sitemap, which
  // belongs to a different deployment.
  const policy = await sharedAccessStore.admissionPolicy().catch(() => null);
  if (!policy || policy.passwordRequired || policy.mode === "individual") {
    return { rules: [{ userAgent: "*", disallow: ["/"] }] };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/explore", "/q/"],
        disallow: ["/admin/", "/api/"],
      },
    ],
    sitemap: "https://flight-finder.org/sitemap.xml",
  };
}
