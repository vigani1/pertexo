import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relatedWebFiles } from './web-unit-selection.mjs';

test('source and changed test files are passed to the related graph', () => {
  assert.deepEqual(
    relatedWebFiles([
      'apps/web/src/features/usage/model/usage-search.ts',
      'apps/web/test/features/usage/trends.test.tsx',
    ]),
    [
      'src/features/usage/model/usage-search.ts',
      'test/features/usage/trends.test.tsx',
    ],
  );
});
test('config, support, dependencies, unknown paths and full events keep all tests', () => {
  for (const path of [
    'apps/web/test/setup.ts',
    'apps/web/test/support/run.ts',
    'apps/web/vitest.config.ts',
    'apps/web/vite.config.ts',
    'apps/web/package.json',
    'apps/web/tsconfig.test.json',
    'packages/contracts/src/index.ts',
    'unknown',
  ])
    assert.equal(relatedWebFiles([path]), undefined, path);
  for (const event of ['push', 'schedule'])
    assert.equal(relatedWebFiles(['apps/web/src/main.tsx'], event), undefined);
});
