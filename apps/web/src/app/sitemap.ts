import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const queries = await prisma.query.findMany({
    where: {
      active: true,
      firstViewedAt: { not: null },
      OR: [
        { isSeed: true },
        { expiresAt: { gt: new Date() } },
      ],
    },
    select: {
      id: true,
      updatedAt: true,
    },
  });

  const queryEntries: MetadataRoute.Sitemap = queries.map((q) => ({
    url: `https://flight-finder.org/q/${q.id}`,
    lastModified: q.updatedAt,
    changeFrequency: 'daily',
    priority: 0.8,
  }));

  return [
    {
      url: 'https://flight-finder.org',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: 'https://flight-finder.org/explore',
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    ...queryEntries,
  ];
}
