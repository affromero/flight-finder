import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { getCronInfo } from '@/lib/cron';

export async function GET() {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'connected';
  } catch {
    checks.database = 'error';
  }

  if (redis) {
    try {
      await redis.ping();
      checks.redis = 'connected';
    } catch {
      checks.redis = 'error';
    }
  } else {
    checks.redis = 'disabled';
  }

  const healthy =
    checks.database === 'connected' &&
    (checks.redis === 'connected' || checks.redis === 'disabled');

  let activeQueries = 0;
  try {
    activeQueries = await prisma.query.count({
      where: { active: true, OR: [{ isSeed: true }, { expiresAt: { gt: new Date() } }] },
    });
  } catch {
    // non-fatal
  }

  const cron = getCronInfo();

  return Response.json(
    { application: 'flight-finder', status: healthy ? 'ok' : 'degraded', ...checks, activeQueries, cron },
    { status: healthy ? 200 : 503 }
  );
}
