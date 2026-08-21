import type { MetadataRoute } from 'next';
import { gateEnabled } from '@/lib/access/gate';

export default function robots(): MetadataRoute.Robots {
  // A gated instance is private: say so plainly rather than advertising routes
  // no crawler can reach anyway, and do not point at the public sitemap, which
  // belongs to a different deployment.
  if (gateEnabled()) {
    return { rules: [{ userAgent: '*', disallow: ['/'] }] };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/explore', '/q/'],
        disallow: ['/admin/', '/api/'],
      },
    ],
    sitemap: 'https://flight-finder.org/sitemap.xml',
  };
}
