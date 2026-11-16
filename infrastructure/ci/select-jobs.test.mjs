import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkspaces, selectJobs } from './select-jobs.mjs';

const workspaces = readWorkspaces();
const select = (file, event) => selectJobs([file], workspaces, event);
const groups = (matrix) => matrix.include.map(({ group }) => group);

test('documentation keeps the static and deployment floor without test jobs', () => {
  const result = select('docs/guide.md');
  assert.equal(result.code, false);
  assert.deepEqual(result.check.part, ['static', 'deploy']);
  for (const job of ['unit', 'integration', 'browser'])
    assert.deepEqual(result[job].include, []);
});

test('web source and web tests run all web tests and live journeys', () => {
  for (const file of [
    'apps/web/src/component.tsx',
    'apps/web/test/component.test.tsx',
  ]) {
    const result = select(file);
    assert.deepEqual(result.check.part, ['static', 'deploy', 'lint-web']);
    assert.deepEqual(result.unit.include, [
      { group: 'web', filter: '--filter @pertexo/web' },
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
    assert.deepEqual(select(file), select('anything', 'push'));
  });

test('pushes and schedules run everything even for docs', () => {
  for (const event of ['push', 'schedule'])
    assert.deepEqual(select('docs/guide.md', event), select('pnpm-lock.yaml'));
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
