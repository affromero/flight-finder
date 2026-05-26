import { apiSuccess } from '@/lib/api-response';
import pkg from '../../../../package.json';

export const dynamic = 'force-dynamic';
export const revalidate = 3600;

const RENAME_RELEASE = '0.9.0';

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function GET() {
  const current = pkg.version;
  let latest: string | null = null;

  try {
    const res = await fetch(
      'https://api.github.com/repos/affromero/flight-finder/releases/latest',
      {
        headers: { Accept: 'application/vnd.github.v3+json' },
        next: { revalidate: 3600 },
      }
    );
    if (res.ok) {
      const data = await res.json();
      latest = (data.tag_name as string)?.replace(/^v/, '') ?? null;
    }
  } catch {
    // GitHub unreachable — return what we have
  }

  const renameAnnouncement = compareSemver(current, RENAME_RELEASE) < 0
    ? {
        from: 'Fairtrail',
        to: 'Flight Finder',
        upgradeCommand: 'fairtrail update',
      }
    : null;

  return apiSuccess({
    current,
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA ?? 'dev',
    latest,
    updateAvailable: latest ? latest !== current : false,
    renameAnnouncement,
  });
}
