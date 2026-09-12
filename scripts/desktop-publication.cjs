const { readdirSync, readFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { createHash } = require('node:crypto');
const { requireChecks, requireRelease } = require('./docker-publication.cjs');

function installers(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return installers(path);
    return entry.isFile() && /\.(dmg|msi|exe|deb|rpm|AppImage|tar\.gz|sig)$/.test(entry.name) ? [path] : [];
  });
}

async function publishDesktop({ github, owner, repo, sha, tag, directory }) {
  await requireRelease({ github, owner, repo, tag, sha });
  await requireChecks({ github, owner, repo, sha, attempts: 1 });
  const files = installers(directory);
  if (!files.some(path => path.endsWith('.dmg')) || !files.some(path => path.endsWith('.msi')) || !files.some(path => path.endsWith('.AppImage'))) {
    throw new Error('Expected installers for macOS, Windows and Linux');
  }
  const names = files.map(path => basename(path));
  if (new Set(names).size !== names.length) throw new Error('Duplicate installer names');
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({ owner, repo, tag }));
  } catch (error) {
    if (error.status !== 404) throw error;
    const { data: file } = await github.rest.repos.getContent({ owner, repo, path: 'CHANGELOG.md', ref: sha });
    const changelog = Buffer.from(file.content, 'base64').toString();
    const heading = `## [${tag.replace(/^desktop-/, '').replace(/^v/, '')}]`;
    const start = changelog.indexOf(heading);
    if (start < 0) throw new Error('Release notes are missing from CHANGELOG.md');
    const end = changelog.indexOf('\n## [', start + heading.length);
    const body = changelog.slice(start, end < 0 ? undefined : end).trim();
    ({ data: release } = await github.rest.repos.createRelease({ owner, repo, tag_name: tag, target_commitish: sha, name: tag, body, draft: false, prerelease: /\d-/.test(tag) }));
  }
  // Preserve existing release notes and assets. Reruns may attach only missing files.
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: release.id, per_page: 100 });
  const pending = [];
  for (const path of files) {
    const name = basename(path);
    const existing = assets.find(asset => asset.name === name);
    if (existing) {
      const digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
      if (existing.digest !== digest) throw new Error(`Refusing to replace published installer ${name}`);
    } else pending.push(path);
  }
  // Recheck after reading assets, immediately before any uploads.
  await requireRelease({ github, owner, repo, tag, sha });
  await requireChecks({ github, owner, repo, sha, attempts: 1 });
  for (const path of pending) {
    await github.rest.repos.uploadReleaseAsset({ owner, repo, release_id: release.id, name: basename(path), data: readFileSync(path) });
  }
}

module.exports = { publishDesktop };
