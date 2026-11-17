import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOURCE_READS,
  browserEntries,
  readWorkspaces,
  selectJobs,
} from './select-jobs.mjs';

const workspaces = readWorkspaces();
const select = (file, event) => selectJobs([file], workspaces, event);
const groups = (matrix) => matrix.include.map(({ group }) => group);
// Fault tests follow their own paths rule, tested below.
const testJobs = ({ faults: _faults, ...jobs }) => jobs;

test('documentation keeps the static and deployment floor without test jobs', () => {
  const result = select('docs/guide.md');
  assert.equal(result.code, false);
  assert.deepEqual(result.check.part, ['static', 'deploy']);
  for (const job of ['unit', 'integration', 'browser'])
    assert.deepEqual(result[job].include, []);
});

test('shared web source and tests use related units and retain all browser journeys', () => {
  for (const file of ['apps/web/test/lib/clock.test.ts']) {
    const result = select(file);
    assert.deepEqual(result.check.part, ['static', 'deploy', 'lint-web']);
    assert.deepEqual(result.unit.include, [
      {
        group: 'web',
        filter: '--filter @pertexo/web',
        related: JSON.stringify([file.slice('apps/web/'.length)]),
      },
    ]);
    assert.deepEqual(result.integration.include, []);
    assert.equal(result.browser.include.length, 5);
  }
});

test('contracts reaches API, worker and web', () => {
  const result = select('packages/contracts/src/index.ts');
  const filters = result.unit.include.map(({ filter }) => filter).join(' ');
  for (const name of ['api', 'worker', 'web'])
    assert.ok(filters.includes(`--filter @pertexo/${name}`));
  assert.deepEqual(groups(result.integration), [
    'database',
    'core',
    'services',
    'worker',
  ]);
  assert.equal(result.browser.include.length, 5);
});

for (const name of ['core', 'database'])
  test(`${name} reaches backend consumers without mocked browsers`, () => {
    const result = select(`packages/${name}/src/change.ts`);
    assert.deepEqual(groups(result.unit), ['core', 'apps']);
    assert.deepEqual(groups(result.integration), [
      'database',
      'core',
      'services',
      'worker',
    ]);
    assert.deepEqual(
      result.browser.include.map(({ suite }) => suite),
      ['live-1', 'live-2', 'live-3'],
    );
    assert.deepEqual(result.check.part, ['static', 'deploy', 'lint-rest']);
  });

for (const file of [
  'pnpm-lock.yaml',
  '.github/workflows/ci.yml',
  '.github/README.md',
  'unknown-root',
  'infrastructure/testing/setup.mjs',
  'eslint.config.mjs',
  'compose.yaml',
  'tsconfig.json',
])
  test(`${file} runs everything`, () => {
    assert.deepEqual(
      testJobs(select(file)),
      testJobs(select('anything', 'push')),
    );
  });

test('pushes and schedules run everything even for docs', () => {
  for (const event of ['push', 'schedule'])
    assert.deepEqual(
      testJobs(select('docs/guide.md', event)),
      testJobs(select('pnpm-lock.yaml')),
    );
});

test('reverse dependency selection is transitive even in reverse order', () => {
  const graph = [
    {
      name: '@pertexo/web',
      path: 'apps/web',
      dependencies: ['@pertexo/contracts'],
    },
    {
      name: '@pertexo/contracts',
      path: 'packages/contracts',
      dependencies: ['@pertexo/policy'],
    },
    { name: '@pertexo/policy', path: 'packages/policy', dependencies: [] },
  ];
  const result = selectJobs(['packages/policy/src/change.ts'], graph);
  assert.ok(result.unit.include.some(({ group }) => group === 'web'));
});

test('every workspace is mapped and a new unmapped workspace fails explicitly', () => {
  const result = select('pnpm-lock.yaml');
  const filters = result.unit.include
    .map(({ filter }) => filter)
    .join(' ')
    .split(' ');
  for (const { name } of workspaces) assert.ok(filters.includes(name), name);
  assert.throws(
    () =>
      selectJobs(
        [],
        [
          ...workspaces,
          { name: '@pertexo/new', path: 'packages/new', dependencies: [] },
        ],
      ),
    /no CI job mapping/,
  );
});

test('fault tests run on pushes and on pull requests that change them or the services they stop', () => {
  assert.equal(select('apps/web/src/component.tsx', 'push').faults, true);
  for (const file of [
    'apps/worker/test/recovery/redis-blip.resilience.integration.test.ts',
    'apps/worker/test/support/recovery/services.ts',
    'apps/worker/vitest.resilience.config.ts',
    'infrastructure/testing/run-fault-shard.mjs',
    '.github/workflows/ci.yml',
    'compose.yaml',
    'infrastructure/postgres/init.sql',
  ])
    assert.equal(select(file).faults, true, file);
  for (const file of [
    'apps/web/src/component.tsx',
    'packages/core/src/change.ts',
    'apps/worker/src/runtime.ts',
    'pnpm-lock.yaml',
  ])
    assert.equal(select(file).faults, false, file);
});

test('live jobs balance recorded work and keep every journey exactly once', () => {
  const durations = JSON.parse(
    readFileSync(
      new URL('../testing/live-durations.json', import.meta.url),
      'utf8',
    ),
  );
  const jobs = browserEntries.filter(({ suite }) => suite.startsWith('live'));
  const files = jobs.flatMap(({ journeys }) => journeys.split(' '));
  assert.deepEqual([...files].sort(), Object.keys(durations).sort());
  const totals = jobs.map(({ journeys }) =>
    journeys.split(' ').reduce((sum, file) => sum + durations[file], 0),
  );
  assert.ok(
    Math.max(...totals) - Math.min(...totals) < 15000,
    totals.join(', '),
  );
});

test('feature-only PRs select only reachable specs and journeys with fewer jobs', () => {
  const selected = select('apps/web/src/features/usage/pages/usage.tsx').browser
    .include;
  const specs = selected
    .filter(({ suite }) => suite.startsWith('mocked'))
    .flatMap(({ specs }) => JSON.parse(specs));
  assert.ok(specs.includes('e2e/usage.spec.ts'));
  assert.ok(!specs.includes('e2e/connections.spec.ts'));
  const journeys = selected
    .filter(({ suite }) => suite.startsWith('live'))
    .flatMap(({ journeys }) => journeys.split(' '));
  assert.ok(journeys.includes('usage'));
  assert.ok(!journeys.includes('two-factor'));
  assert.ok(selected.length < 5);
});

for (const file of [
  'apps/web/src/lib/api/client.ts',
  'apps/web/src/routes/root/layout.tsx',
  'apps/web/e2e/support/fixtures.ts',
  'packages/contracts/src/index.ts',
  'unknown-path',
])
  test(`${file} preserves complete browser coverage`, () => {
    assert.deepEqual(select(file).browser.include, browserEntries);
  });

test('backend changes retain every live journey', () => {
  assert.deepEqual(
    select('apps/api/src/main.ts').browser.include,
    browserEntries.filter(({ suite }) => suite.startsWith('live')),
  );
});

test('a feature used by another feature retains that feature’s browser coverage', () => {
  const selected = select(
    'apps/web/src/features/failure-notifications/public.ts',
  ).browser.include;
  const specs = selected
    .filter(({ suite }) => suite.startsWith('mocked'))
    .flatMap(({ specs }) => JSON.parse(specs));
  assert.ok(specs.includes('e2e/approvals/setup.spec.ts'));
});

test('Home changes retain journeys that create a workspace through the ordinary UI', () => {
  const jobs = select('apps/web/src/features/overview/pages/home.tsx').browser
    .include;
  const journeys = jobs
    .flatMap(({ journeys }) => journeys.split(' '))
    .filter(Boolean);
  assert.ok(journeys.includes('api-tokens'));
  assert.ok(journeys.includes('collaboration'));
});

test('Usage changes retain the webhook journey that opens the Usage page', () => {
  const jobs = select('apps/web/src/features/usage/pages/workspace-usage.tsx')
    .browser.include;
  assert.ok(
    jobs
      .flatMap(({ journeys }) => journeys.split(' '))
      .includes('webhook-responses'),
  );
});

test('full and large related runs have two shards while a changed test keeps one job', () => {
  for (const file of [
    'apps/web/test/setup.ts',
    'apps/web/vitest.config.ts',
    'packages/contracts/src/index.ts',
    'apps/web/src/unknown-file.ts',
  ]) {
    assert.deepEqual(
      select(file)
        .unit.include.filter(({ group }) => group === 'web')
        .map(({ shard }) => shard),
      [1, 2],
    );
  }
  const feature = select('apps/web/src/features/usage/model/usage-search.ts')
    .unit.include;
  assert.equal(feature.length, 2);
  assert.deepEqual(
    feature.map(({ shard }) => shard),
    [1, 2],
  );
  assert.deepEqual(JSON.parse(feature[0].related), [
    'src/features/usage/model/usage-search.ts',
  ]);
  for (const event of ['push', 'schedule'])
    assert.deepEqual(
      select('apps/web/src/features/usage/model/usage-search.ts', event)
        .unit.include.filter(({ group }) => group === 'web')
        .map(({ shard }) => shard),
      [1, 2],
    );
});

test('a change to an app selects the tests that read its source as text', () => {
  const filters = select('apps/api/src/webhooks/ingress/telemetry.ts')
    .unit.include.map(({ filter }) => filter)
    .join(' ');
  assert.ok(filters.includes('--filter @pertexo/observability'));
});

// Selection and the narrow web build trust declared dependencies, so a
// workspace that reaches another one without declaring it can skip the tests or
// the build it needs.
test('workspaces reach each other only through declared dependencies or listed source reads', () => {
  const byDirectory = Object.fromEntries(
    workspaces.map(({ path, name }) => [path.split('/')[1], name]),
  );
  const undeclared = [];
  for (const { path, name, dependencies } of workspaces) {
    const allowed = new Set([
      name,
      ...dependencies,
      ...(SOURCE_READS[name] ?? []),
    ]);
    for (const folder of ['src', 'test', 'e2e', 'e2e-live']) {
      const root = join(path, folder);
      if (!existsSync(root)) continue;
      for (const file of readdirSync(root, { recursive: true })) {
        if (!/\.(?:ts|tsx|mts|mjs)$/u.test(file)) continue;
        const text = readFileSync(join(root, file), 'utf8');
        const reached = [
          ...[
            ...text.matchAll(
              /['"](?:\.\.\/)+(?:packages|apps)\/([a-z0-9-]+)\//gu,
            ),
          ].map(([, directory]) => byDirectory[directory]),
          ...[...text.matchAll(/from ['"](@pertexo\/[a-z0-9-]+)/gu)].map(
            ([, imported]) => imported,
          ),
        ];
        for (const target of reached)
          if (target && !allowed.has(target))
            undeclared.push(`${path}/${folder}/${file} -> ${target}`);
      }
    }
  }
  assert.deepEqual([...new Set(undeclared)], []);
});
