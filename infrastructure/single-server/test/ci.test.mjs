import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { test } from 'node:test';
import { it } from './support/it.mjs';

// CI can't be run from here, so these read the workflow files for the promises the
// operator depends on. What only a real run can prove is listed in the batch notes.
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobText = (job) => JSON.stringify(job);
const publishingJobs = Object.entries(ci.jobs).filter(
  ([, job]) => job.permissions?.packages === 'write',
);
const neededBy = (name) => {
  const direct = [ci.jobs[name].needs ?? []].flat();
  return new Set([...direct, ...direct.flatMap((need) => [...neededBy(need)])]);
};

// ops-05, docs-deps-product-05
it('publishes every image for both x86 and ARM under one tag', () => {
  const text = publishingJobs.map(([, job]) => jobText(job)).join();
  assert.match(text, /linux\/amd64/u);
  assert.match(text, /linux\/arm64/u);
  assert.match(text, /imagetools create|linux\/amd64,linux\/arm64/u);
  for (const image of ['pertexo', 'pertexo-web'])
    assert.match(text, new RegExp(`ghcr\\.io/vigani1/${image}\\b`, 'u'));
});

test('qualifies what it publishes before anyone can pull it', () => {
  const text = publishingJobs.map(([, job]) => jobText(job)).join();
  for (const check of [
    'backup/verify-runtime.mjs',
    'images/code/verify.mjs',
    'images/verify-web.mjs',
  ])
    assert.ok(text.includes(check), check);
});

// ops-09: 7 of 75 main pushes failed, one on a docs commit that can't have caused it.
// Tags name commits; only a release says a commit is good.
it(
  'publishes an image for every merged commit, whatever the test jobs did',
  () => {
    assert.ok(publishingJobs.length > 0);
    for (const [name, job] of publishingJobs) {
      for (const blocker of [
        'check',
        'unit',
        'integration',
        'browser',
        'e2e',
        'security',
      ])
        assert.ok(!neededBy(name).has(blocker), `${name} waits for ${blocker}`);
      assert.match(job.if ?? '', /refs\/heads\/main/u);
      assert.doesNotMatch(job.if ?? '', /docs|changes|paths/u);
    }
  },
);

// ops-09, docs-deps-product-17
it(
  'a version tag publishes a release with notes and moves the stable tag',
  () => {
    const path = '.github/workflows/release.yml';
    assert.ok(existsSync(path), path);
    const release = parse(readFileSync(path, 'utf8'));
    const tags = release.on.push.tags;
    assert.ok(tags.some((tag) => tag.startsWith('v')));
    const text = JSON.stringify(release);
    // The released image is the one every merged commit already published and tested.
    assert.match(text, /imagetools create/u);
    assert.match(text, /:stable/u);
    assert.doesNotMatch(text, /buildx build/u);
    // A commit whose tests failed can have an image, but never a release.
    assert.match(text, /verify-ci|gh run|check-runs/u);
    assert.match(text, /CHANGELOG\.md/u);
    assert.match(text, /gh release create|action-gh-release/u);
  },
);

// ops-11: the test that would have caught ops-01, ops-02 and the fresh-install failure.
test('runs the real deploy, backup and restore scripts on a real stack, on both architectures', () => {
  const job = ci.jobs['self-host-drill'];
  assert.ok(job);
  assert.notEqual(job['continue-on-error'], true);
  const text = jobText(job);
  assert.match(text, /test\/drill\/build-images\.mjs/u);
  assert.match(text, /test\/drill\/stack\.test\.mjs/u);
  assert.match(text, /test\/drill\/proxy\.test\.mjs/u);
  assert.match(text, /test\/drill\/quickstart\.test\.mjs/u);
  const runners = job.strategy.matrix.runner;
  assert.ok(runners.some((runner) => runner.endsWith('-arm')));
  assert.ok(runners.some((runner) => !runner.endsWith('-arm')));
});

test('keeps the fast deployment checks in the required check job', () => {
  assert.match(
    jobText(ci.jobs.check),
    /infrastructure\/single-server\/test\/\*\.test\.mjs/u,
  );
});
