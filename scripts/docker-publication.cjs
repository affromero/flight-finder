const { execFileSync } = require('node:child_process');

const REQUIRED_WORKFLOWS = ['ci.yml', 'car-tests.yml', 'hotel-tests.yml', 'desktop-ci.yml'];

async function requireRelease({ github, owner, repo, tag, sha }) {
  if (!/^(?:desktop-)?v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Select an existing version release tag');
  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: `refs/tags/${tag}` });
  if (sha && commit.sha !== sha) throw new Error('Release tag moved after verification');
  const { data: file } = await github.rest.repos.getContent({ owner, repo, path: 'apps/web/package.json', ref: commit.sha });
  const { version } = JSON.parse(Buffer.from(file.content, 'base64').toString());
  if (tag !== `v${version}` && tag !== `desktop-v${version}`) throw new Error('Release tag does not match package version');
  return commit.sha;
}

async function requireChecks({ github, owner, repo, sha, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 60 }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Publication requires a full commit SHA');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pending = [];
    for (const workflow_id of REQUIRED_WORKFLOWS) {
      const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id, head_sha: sha, event: 'push', branch: 'main', per_page: 100 });
      const run = data.workflow_runs
        .filter((candidate) => candidate.head_sha === sha && candidate.event === 'push' && candidate.head_branch === 'main')
        .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
      if (!run || run.status !== 'completed') pending.push(workflow_id);
      else if (run.conclusion !== 'success') throw new Error(`${workflow_id} did not pass for ${sha}: ${run.conclusion}`);
    }
    if (pending.length === 0) return;
    if (attempt + 1 === attempts) throw new Error(`Missing completed checks for ${sha}: ${pending.join(', ')}`);
    await wait(30_000);
  }
}

function docker(...args) {
  return execFileSync('docker', ['buildx', 'imagetools', ...args], { encoding: 'utf8' }).trim();
}

function inspect(reference, run = docker) {
  try {
    return JSON.parse(run('inspect', reference, '--raw'));
  } catch (error) {
    // Authentication and network failures must not be mistaken for an absent tag.
    if (/manifest unknown|not found|MANIFEST_UNKNOWN/.test(String(error.stderr))) return null;
    throw error;
  }
}

function platformDigests(manifest) {
  return (manifest.manifests || [])
    .filter(({ platform }) => platform?.os === 'linux' && ['amd64', 'arm64'].includes(platform.architecture))
    .map(({ digest, platform }) => `${platform.architecture}:${digest}`).sort();
}

function sameImages(left, right) {
  const a = platformDigests(left);
  const b = platformDigests(right);
  return a.length === 2 && b.length === 2 && a[0].startsWith('amd64:') && a[1].startsWith('arm64:') && JSON.stringify(a) === JSON.stringify(b);
}

function verifyRevision(image, manifest, sha, run) {
  if (!sameImages(manifest, manifest)) throw new Error('Expected Linux amd64 and arm64 images');
  for (const descriptor of manifest.manifests.filter(({ platform }) => platform?.os === 'linux')) {
    const config = JSON.parse(run('inspect', `${image}@${descriptor.digest}`, '--format', '{{json .Image}}'));
    if (config.config?.Labels?.['org.opencontainers.image.revision'] !== sha) throw new Error('Image revision does not match the verified commit');
  }
}

async function publish({ github, owner, repo, sha, image, digests, releaseTag, version, run = docker }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[\w./-]+$/.test(image)) throw new Error('Invalid image identity');
  if (digests.length !== 2 || digests.some((value) => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new Error('Expected two platform digests');
  const sources = digests.map((digest) => `${image}@${digest}`);
  const candidate = JSON.parse(run('create', '--dry-run', ...sources));
  if (platformDigests(candidate).length !== 2) throw new Error('Expected Linux amd64 and arm64 images');
  const immutable = `${image}:${sha}`;
  const existing = inspect(immutable, run);
  // Rebuilds may have different timestamps or attestations. Keep the first verified image.
  verifyRevision(image, existing || candidate, sha, run);
  if (!existing) run('create', '-t', immutable, ...sources);
  const published = inspect(immutable, run);
  if (!published || !sameImages(published, existing || candidate)) throw new Error('Published image failed platform verification');

  if (releaseTag) {
    if (releaseTag !== `v${version}` || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Release tag does not match package version');
    const { data: tag } = await github.rest.repos.getCommit({ owner, repo, ref: `refs/tags/${releaseTag}` });
    if (tag.sha !== sha) throw new Error('Release tag moved after the build');
    const versionImage = `${image}:${version}`;
    const previous = inspect(versionImage, run);
    if (previous && !sameImages(previous, published)) throw new Error(`Refusing to overwrite released version ${version}`);
    if (!previous) run('create', '-t', versionImage, immutable);
  }
  // The job's concurrency lock serializes promotions. Check main again after all builds.
  const { data: main } = await github.rest.repos.getCommit({ owner, repo, ref: 'main' });
  if (main.sha === sha) run('create', '-t', `${image}:latest`, immutable);
}

module.exports = { requireChecks, requireRelease, publish, REQUIRED_WORKFLOWS };
