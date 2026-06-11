import styles from './page.module.css';

export const dynamic = 'force-dynamic';
export const revalidate = 3600;

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  draft: boolean;
  assets: GhAsset[];
}

interface OsCard {
  os: string;
  label: string;
  patterns: RegExp[];
}

const OS_CARDS: OsCard[] = [
  { os: 'macOS', label: 'Apple (macOS)', patterns: [/\.dmg$/i] },
  { os: 'Windows', label: 'Windows', patterns: [/\.msi$/i, /setup\.exe$/i, /\.exe$/i] },
  { os: 'Linux', label: 'Linux', patterns: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i] },
];

const INSTALLER_RE = /\.(dmg|exe|msi|AppImage|deb|rpm)$/i;

async function fetchDesktopRelease(): Promise<{ version: string; assets: GhAsset[] } | null> {
  try {
    const res = await fetch(
      'https://api.github.com/repos/affromero/flight-finder/releases?per_page=30',
      { headers: { Accept: 'application/vnd.github.v3+json' }, next: { revalidate: 3600 } },
    );
    if (!res.ok) return null;
    const releases = (await res.json()) as GhRelease[];
    // Latest non-draft release that actually ships desktop installers -- works
    // whether they came from a `desktop-v*` tag or a coupled `v*` release.
    const rel = releases.find(
      (r) => !r.draft && (r.assets ?? []).some((a) => INSTALLER_RE.test(a.name)),
    );
    if (!rel) return null;
    return { version: rel.tag_name.replace(/^(desktop-)?v/, ''), assets: rel.assets ?? [] };
  } catch {
    return null;
  }
}

function pickAsset(assets: GhAsset[], patterns: RegExp[]): GhAsset | null {
  for (const p of patterns) {
    const found = assets.find((a) => p.test(a.name));
    if (found) return found;
  }
  return null;
}

export default async function DownloadPage() {
  const release = await fetchDesktopRelease();

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Download Flight Finder</h1>
        <p className={styles.subtitle}>
          The desktop app runs a self-hosted instance on your computer, or
          connects to one on your VPS, with no terminal.
        </p>
        {release && <p className={styles.version}>Latest: v{release.version}</p>}
      </header>

      {release ? (
        <div className={styles.cards}>
          {OS_CARDS.map((card) => {
            const asset = pickAsset(release.assets, card.patterns);
            return (
              <div key={card.os} className={styles.card}>
                <span className={styles.os}>{card.label}</span>
                {asset ? (
                  <a className={styles.button} href={asset.browser_download_url}>
                    Download
                  </a>
                ) : (
                  <span className={styles.unavailable}>Not in this release</span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty}>
          <p>No desktop release is published yet.</p>
          <p className={styles.emptyHint}>
            You can still run Flight Finder from the terminal:
            <br />
            <code>curl -fsSL https://flight-finder.org/install.sh | bash</code>
          </p>
        </div>
      )}

      <p className={styles.note}>
        Prefer the terminal, or running on a server? See the{' '}
        <a href="https://github.com/affromero/flight-finder#readme">README</a> for
        the one-command installer and VPS setup.
      </p>
    </main>
  );
}
