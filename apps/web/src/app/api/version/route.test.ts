import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET } from './route';
import pkg from '../../../../package.json';

function githubReleases(releases: { tag_name: string; prerelease?: boolean; draft?: boolean }[]): Response {
  return new Response(JSON.stringify(releases), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/version', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores desktop releases when resolving the latest web version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      githubReleases([
        { tag_name: `desktop-v${pkg.version}` },
        { tag_name: `v${pkg.version}` },
      ]),
    );
    const data = (await (await GET()).json()).data;
    expect(data.latest).toBe(pkg.version);
    expect(data.updateAvailable).toBe(false);
  });

  it('flags an update only when the latest web release is newer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      githubReleases([
        { tag_name: 'desktop-v99.0.0' },
        { tag_name: 'v99.0.0' },
        { tag_name: `v${pkg.version}` },
      ]),
    );
    const data = (await (await GET()).json()).data;
    expect(data.latest).toBe('99.0.0');
    expect(data.updateAvailable).toBe(true);
  });

  it('skips prereleases and drafts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      githubReleases([
        { tag_name: 'v99.0.0', prerelease: true },
        { tag_name: 'v98.0.0', draft: true },
        { tag_name: `v${pkg.version}` },
      ]),
    );
    const data = (await (await GET()).json()).data;
    expect(data.latest).toBe(pkg.version);
    expect(data.updateAvailable).toBe(false);
  });

  it('returns no update when GitHub is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    const data = (await (await GET()).json()).data;
    expect(data.latest).toBeNull();
    expect(data.updateAvailable).toBe(false);
  });
});
