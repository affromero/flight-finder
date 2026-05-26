import { prisma } from '@/lib/prisma';

const HUB_URL = process.env.COMMUNITY_HUB_URL || 'https://flight-finder.org';
const MAX_BATCH_SIZE = 500;

interface CommunityPayload {
  snapshots: {
    origin: string;
    destination: string;
    travelDate: string;
    price: number;
    currency: string;
    airline: string;
    stops: number;
    cabinClass: string;
    scrapedAt: string;
  }[];
}

export async function registerForCommunity(): Promise<string> {
  const res = await fetch(`${HUB_URL}/api/community/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Registration failed: ${(body as { error?: string }).error || res.statusText}`);
  }

  const data = (await res.json()) as { data: { apiKey: string } };
  return data.data.apiKey;
}

export async function syncToHub(): Promise<void> {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

  if (!config?.communitySharing || !config.communityApiKey) {
    return;
  }

  // Get snapshots newer than last sync, JOIN with Query for route info
  const snapshots = await prisma.priceSnapshot.findMany({
    where: {
      scrapedAt: config.lastCommunitySyncAt
        ? { gt: config.lastCommunitySyncAt }
        : undefined,
      status: 'available',
    },
    include: {
      query: {
        select: {
          origin: true,
          destination: true,
          cabinClass: true,
        },
      },
    },
    orderBy: { scrapedAt: 'asc' },
    take: MAX_BATCH_SIZE,
  });

  if (snapshots.length === 0) return;

  const payload: CommunityPayload = {
    snapshots: snapshots.map((s: typeof snapshots[number]) => ({
      origin: s.query.origin,
      destination: s.query.destination,
      travelDate: s.travelDate.toISOString().split('T')[0]!,
      price: s.price,
      currency: s.currency,
      airline: s.airline,
      stops: s.stops,
      cabinClass: s.query.cabinClass,
      scrapedAt: s.scrapedAt.toISOString(),
    })),
  };

  const res = await fetch(`${HUB_URL}/api/community/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.communityApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`[community] Sync failed: ${(body as { error?: string }).error || res.statusText}`);
    return;
  }

  // Update sync timestamp to the latest snapshot we sent
  const latestScrapedAt = snapshots[snapshots.length - 1]!.scrapedAt;
  await prisma.extractionConfig.update({
    where: { id: 'singleton' },
    data: { lastCommunitySyncAt: latestScrapedAt },
  });

  console.log(`[community] Synced ${snapshots.length} snapshots to hub`);
}
