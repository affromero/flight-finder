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
    // List releases instead of /releases/latest: GitHub's "latest" is just the
    // newest release, which can be a desktop-vX.Y.Z installer release. Only
    // vX.Y.Z tags track the web app.
    const res = await fetch(
      'https://api.github.com/repos/affromero/flight-finder/releases?per_page=15',
      {
        headers: { Accept: 'application/vnd.github.v3+json' },
        next: { revalidate: 3600 },
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string; prerelease?: boolean; draft?: boolean }[];
      const webRelease = data.find(
        (r) => /^v\d+\.\d+\.\d+$/.test(r.tag_name ?? '') && !r.prerelease && !r.draft,
      );
      latest = webRelease?.tag_name?.replace(/^v/, '') ?? null;
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
    updateAvailable: latest ? compareSemver(latest, current) > 0 : false,
    renameAnnouncement,
  });
}
