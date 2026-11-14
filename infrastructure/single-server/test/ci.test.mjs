import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { test } from 'node:test';
import { it } from 'node:test';

// CI can't be run from here, so these read the workflow files for the promises the
// operator depends on. What only a real run can prove is listed in the batch notes.
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const publish = parse(readFileSync('.github/workflows/publish.yml', 'utf8'));
const jobText = (job) => JSON.stringify(job);
const publishingJobs = Object.entries(publish.jobs).filter(
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

// A full run per merge used 27 jobs of the 20 GitHub allows, and pull requests queued.
test('main tests one commit at a time and never cancels the run under way', () => {
  assert.doesNotMatch(ci.concurrency.group, /github\.sha/u);
  assert.equal(
    ci.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' }}",
  );
});

// Faults kill Postgres and check what survives, which an fsync-off database can't show.
test('turns off Postgres durability only where nothing tests it', () => {
  assert.equal(ci.env.POSTGRES_DURABILITY, 'off');
  assert.equal(ci.jobs.faults.env.POSTGRES_DURABILITY, 'on');
  const compose = parse(readFileSync('compose.yaml', 'utf8'));
  // Not synchronous_commit: until a commit is flushed, VACUUM can't mark its pages
  // all-visible, which the query-plan tests read. With fsync off it saves almost nothing.
  for (const setting of ['fsync', 'full_page_writes'])
    assert.ok(
      compose.services.postgres.command.includes(
        `${setting}=\${POSTGRES_DURABILITY:-on}`,
      ),
      setting,
    );
});

// CI pins each service image itself, and .env.example copies it, so a Compose
// update that misses either one leaves CI testing an image nobody runs
// (review of PR #707, P2: s3mock 5.2.3 locally, 5.1.0 in CI).
test('CI and .env.example pin every service image the Compose defaults use', () => {
  const defaults = [
    ...readFileSync('compose.yaml', 'utf8').matchAll(
      /\$\{(\w+_IMAGE):-([^}]+)\}/gu,
    ),
  ].map(([, name, image]) => [name, image]);
  assert.ok(defaults.length > 0);
  const example = Object.fromEntries(
    readFileSync('.env.example', 'utf8')
      .split('\n')
      .map((line) => /^(\w+_IMAGE)=(.+)$/u.exec(line)?.slice(1))
      .filter((pair) => pair !== undefined),
  );
  for (const [name, image] of defaults) {
    assert.equal(ci.env[name], image, `${name} in .github/workflows/ci.yml`);
    assert.equal(example[name], image, `${name} in .env.example`);
  }
});

// s3mock writes absolute store paths into its bucket and object metadata, so a
// volume written at /data reads back only at /data (review of PR #707, P1).
test('keeps the S3 mock store where its volume is mounted, at /data', () => {
  const compose = parse(readFileSync('compose.yaml', 'utf8'));
  const store = compose.services['artifact-store'];
  const mounts = store.volumes.map((volume) => volume.split(':')[1]);
  assert.deepEqual(mounts, ['/data']);
  assert.equal(store.environment.COM_ADOBE_TESTING_S3MOCK_STORE_ROOT, '/data');
});

// A leg dropped from a matrix takes its tests with it while every other leg stays green.
test('the gate requires a split suite, and every one of its shards exists', () => {
  const shards = ci.jobs.browser.strategy.matrix.include.flatMap(
    ({ shard }) => shard ?? [],
  );
  assert.ok(shards.length > 1);
  assert.deepEqual(
    shards,
    shards.map((_, index) => `${index + 1}/${shards.length}`),
  );
  for (const name of ['integration', 'browser'])
    assert.ok(neededBy('ci-passed').has(name), name);
  // The worker suite's shards run inside one job: see run-worker-suite.mjs.
  assert.ok(
    ci.jobs.integration.strategy.matrix.include.some(
      ({ group }) => group === 'worker',
    ),
  );
  assert.match(jobText(ci.jobs.integration), /run-worker-suite\.mjs/u);
});

// ops-09: 7 of 75 main pushes failed, one on a docs commit that can't have caused it.
// Tags name commits; only a release says a commit is good.
it('publishes an image for every merged commit, whatever the test jobs did', () => {
  assert.ok(publishingJobs.length > 0);
  // Its own workflow, so nothing in CI can hold it up or replace it.
  assert.deepEqual(Object.keys(publish.on), ['push']);
  assert.deepEqual(publish.on.push, { branches: ['main'] });
  assert.equal(publish.concurrency, undefined);
  for (const [name, job] of publishingJobs)
    assert.equal(job.if, undefined, name);
});

// A lost runner mustn't leave a commit without images, or a job without its retry.
test('retries a lost runner in publishing as well as in CI', () => {
  const retry = parse(
    readFileSync('.github/workflows/retry-lost-runner.yml', 'utf8'),
  );
  for (const { name } of [ci, publish])
    assert.ok(retry.on.workflow_run.workflows.includes(name), name);
});

// ops-09, docs-deps-product-17
it('a version tag publishes a release with notes and moves the stable tag', () => {
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
});

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

// The drill takes about 22 minutes a leg: a pull request that didn't touch what it
// covers must not wait for it, and one that did must not get past it.
test('runs the drill on main, on the schedule, and only on pull requests that touch what it covers', () => {
  const drill = ci.jobs['self-host-drill'];
  assert.deepEqual([drill.needs].flat(), ['self-host-changes']);
  assert.match(drill.if, /github\.event_name != 'pull_request'/u);
  assert.match(
    drill.if,
    /needs\.self-host-changes\.outputs\.touched == 'true'/u,
  );
  const classify = jobText(ci.jobs['self-host-changes']);
  const paths = /grep -qE '([^']+)'/u.exec(classify)?.[1];
  assert.ok(paths, classify);
  const touches = (file) => new RegExp(paths, 'u').test(file);
  for (const file of [
    'infrastructure/single-server/deploy.sh',
    'infrastructure/quickstart/compose.yaml',
    'Dockerfile',
    'apps/web/deployment/nginx.conf.template',
  ])
    assert.ok(touches(file), file);
  for (const file of [
    'apps/api/src/app.ts',
    'docs/operations/single-server.md',
    'packages/database/src/database.ts',
    'infrastructure/checks/third-party-notices.mjs',
    'infrastructure/development/check-cache.mjs',
  ])
    assert.ok(!touches(file), file);
});
