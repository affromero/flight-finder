const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { publishDesktop } = require('./desktop-publication.cjs');
const sha = 'a'.repeat(40);

function fixture(t, { tagSha = sha, conclusion = 'success', assets = [], notes = 'Original human release notes' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-publication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const names = ['flight.dmg', 'flight.msi', 'flight.AppImage'];
  for (const name of names) writeFileSync(join(directory, name), name);
  const uploads = [];
  const release = { id: 1, body: notes };
  const github = {
    paginate: async () => assets,
    rest: {
      actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion }] } }) },
      repos: {
        getCommit: async () => ({ data: { sha: tagSha } }),
        getContent: async () => ({ data: { content: Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64') } }),
        getReleaseByTag: async () => ({ data: release }),
        listReleaseAssets() {},
        uploadReleaseAsset: async ({ name, data }) => uploads.push({ name, data: data.toString() }),
      },
    },
  };
  return { names, uploads, release, execute: (tag = 'desktop-v1.2.3') => publishDesktop({ github, owner: 'owner', repo: 'app', sha, tag, directory }) };
}

test('desktop publication preserves release notes and uploads all native installers', async t => {
  const result = fixture(t);
  await result.execute();
  assert.deepEqual(result.uploads.map(value => value.name).sort(), result.names.sort());
  assert.equal(result.release.body, 'Original human release notes');
});

test('desktop publication rejects moved tags, branches and failed checks before uploads', async t => {
  for (const options of [{ tagSha: 'b'.repeat(40) }, { conclusion: 'failure' }, {}]) {
    const result = fixture(t, options);
    await assert.rejects(result.execute(Object.keys(options).length ? undefined : 'main'));
    assert.deepEqual(result.uploads, []);
  }
});

test('desktop reruns preserve identical assets and refuse replacement', async t => {
  const name = 'flight.dmg';
  const digest = `sha256:${createHash('sha256').update(name).digest('hex')}`;
  const same = fixture(t, { assets: [{ name, digest }] });
  await same.execute();
  assert.ok(!same.uploads.some(value => value.name === name));
  const different = fixture(t, { assets: [{ name, digest: 'sha256:other' }] });
  await assert.rejects(different.execute(), /replace published installer/);
  assert.deepEqual(different.uploads, []);
});
