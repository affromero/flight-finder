const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireChecks, publish, REQUIRED_WORKFLOWS } = require('./docker-publication.cjs');

const sha = 'a'.repeat(40);
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const manifest = (second = 'c') => ({ manifests: [
  { digest: digest('b'), platform: { os: 'linux', architecture: 'amd64' } },
  { digest: digest(second), platform: { os: 'linux', architecture: 'arm64' } },
] });
const image = 'ghcr.io/owner/app';
const successful = { id: 1, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };

function checks(runs) {
  return { rest: { actions: { listWorkflowRuns: async ({ workflow_id }) => ({ data: { workflow_runs: runs[workflow_id] || [] } }) } } };
}

test('publication requires every workflow on the exact main commit', async () => {
  const runs = Object.fromEntries(REQUIRED_WORKFLOWS.map((name) => [name, [successful]]));
  await requireChecks({ github: checks(runs), sha, attempts: 1 });
  for (const name of REQUIRED_WORKFLOWS) {
    for (const invalid of [[], [{ ...successful, head_sha: 'd'.repeat(40) }], [{ ...successful, event: 'pull_request' }], [{ ...successful, status: 'in_progress' }]]) {
      await assert.rejects(requireChecks({ github: checks({ ...runs, [name]: invalid }), sha, attempts: 1 }), /Missing completed checks/);
    }
  }
});

test('a failed newer run cannot inherit an older success', async () => {
  const runs = Object.fromEntries(REQUIRED_WORKFLOWS.map((name) => [name, [successful]]));
  runs['ci.yml'].push({ ...successful, id: 2, conclusion: 'failure' });
  await assert.rejects(requireChecks({ github: checks(runs), sha, attempts: 1 }), /did not pass.*failure/);
});

test('publication waits for checks still running and rejects a failed rerun', async () => {
  const runs = Object.fromEntries(REQUIRED_WORKFLOWS.map((name) => [name, [{ ...successful, status: 'in_progress' }]]));
  await requireChecks({ github: checks(runs), sha, attempts: 2, wait: async () => {
    for (const values of Object.values(runs)) values[0].status = 'completed';
  } });
  runs['ci.yml'].push({ ...successful, run_attempt: 2, conclusion: 'cancelled' });
  await assert.rejects(requireChecks({ github: checks(runs), sha, attempts: 1 }), /cancelled/);
});

function publication({ main = sha, existing = {}, releaseTag = '', tagSha = sha, imageSha = sha } = {}) {
  const tags = new Map(Object.entries(existing));
  const writes = [];
  const run = (...args) => {
    if (args[0] === 'inspect') {
      if (args.includes('--format')) return JSON.stringify({ config: { Labels: { 'org.opencontainers.image.revision': imageSha } } });
      if (tags.has(args[1])) return JSON.stringify(tags.get(args[1]));
      const error = new Error('absent');
      error.stderr = 'manifest unknown';
      throw error;
    }
    if (args[1] === '--dry-run') return JSON.stringify(manifest());
    assert.equal(args[0], 'create');
    assert.equal(args[1], '-t');
    writes.push(args[2]);
    tags.set(args[2], manifest());
    return '';
  };
  const github = { rest: { repos: { getCommit: async ({ ref }) => ({ data: { sha: ref === 'main' ? main : tagSha } }) } } };
  return { writes, execute: () => publish({ github, owner: 'owner', repo: 'app', sha, image, digests: [digest('b'), digest('c')], version: '1.2.3', releaseTag, run }) };
}

test('historical builds publish only their immutable commit', async () => {
  const result = publication({ main: 'd'.repeat(40) });
  await result.execute();
  assert.deepEqual(result.writes, [`${image}:${sha}`]);
});

test('current main promotes latest without overwriting a release version', async () => {
  const result = publication();
  await result.execute();
  assert.deepEqual(result.writes, [`${image}:${sha}`, `${image}:latest`]);
});

test('images with a different revision cannot be reused under a commit tag', async () => {
  const result = publication({ imageSha: 'e'.repeat(40), existing: { [`${image}:${sha}`]: manifest('e') } });
  await assert.rejects(result.execute(), /revision/);
  assert.deepEqual(result.writes, []);
});

test('a rebuild preserves the first verified immutable image', async () => {
  const result = publication({ main: 'd'.repeat(40), existing: { [`${image}:${sha}`]: manifest('e') } });
  await result.execute();
  assert.deepEqual(result.writes, []);
});

test('release versions reject replacement and accept identical reruns', async () => {
  const conflict = publication({ releaseTag: 'v1.2.3', existing: { [`${image}:1.2.3`]: manifest('e') } });
  await assert.rejects(conflict.execute(), /overwrite released version/);
  assert.ok(!conflict.writes.includes(`${image}:1.2.3`));
  const same = publication({ releaseTag: 'v1.2.3', existing: { [`${image}:${sha}`]: manifest(), [`${image}:1.2.3`]: manifest() } });
  await same.execute();
  assert.deepEqual(same.writes, [`${image}:latest`]);
});

test('moved or mismatched release tags cannot publish version aliases', async () => {
  for (const options of [{ releaseTag: 'v9.9.9' }, { releaseTag: 'v1.2.3', tagSha: 'd'.repeat(40) }]) {
    const result = publication(options);
    await assert.rejects(result.execute(), /tag/);
    assert.ok(!result.writes.includes(`${image}:1.2.3`));
    assert.ok(!result.writes.includes(`${image}:latest`));
  }
});

test('registry authentication errors stop publication without creating tags', async () => {
  const writes = [];
  const run = (...args) => {
    if (args.includes('--dry-run')) return JSON.stringify(manifest());
    if (args[0] === 'create') writes.push(args);
    const error = new Error('unauthorized');
    error.stderr = '401 Unauthorized';
    throw error;
  };
  await assert.rejects(publish({ sha, image, digests: [digest('b'), digest('c')], run }), /unauthorized/);
  assert.deepEqual(writes, []);
});
