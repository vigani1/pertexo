import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifySourceKind,
  createSourceInventory,
  mapSourceTestSuites,
  sourceFilesInCollection,
} from './generate-coverage-evidence.mjs';

test('classifies declaration-only and executable TypeScript without evaluating it', () => {
  assert.equal(
    classifySourceKind(
      'types.ts',
      "import type { A } from './a.js'; export type { A }; interface B { x: A }\n",
    ),
    'declarations-imports-or-reexports-only',
  );
  assert.equal(
    classifySourceKind('runtime.ts', 'export const value = 1;\n'),
    'runtime-statements-present',
  );
});

test('accounts for every source and distinguishes mapped from unmapped runtime', () => {
  const rootDirectory = '/repo';
  const inventory = createSourceInventory({
    artifactHashes: { coverage: [] },
    coverageReports: new Map([
      [
        'api',
        {
          '/repo/apps/api/src/measured.ts': {
            s: { 0: 1, 1: 0 },
          },
        },
      ],
    ]),
    generatedAt: '2026-09-12T00:00:00.000Z',
    packageManager: 'pnpm@10.17.1',
    riskReport: {
      sourceRevision: `sha256:${'a'.repeat(64)}`,
      uncoveredBranches: [
        { file: 'apps/api/src/measured.ts' },
        { file: 'apps/api/src/measured.ts' },
      ],
    },
    rootDirectory,
    sources: new Map([
      ['apps/api/src/measured.ts', 'export const value = true;\n'],
      ['apps/api/src/main.ts', 'await Promise.resolve();\n'],
      ['apps/api/src/owned.ts', 'export const owned = true;\n'],
      ['packages/contracts/src/index.ts', "export type { A } from './a.js';\n"],
    ]),
    testSuitesBySource: new Map([
      ['apps/api/src/owned.ts', ['apps/api/test/owned.test.ts']],
    ]),
  });

  assert.equal(inventory.sourceFiles, 4);
  assert.deepEqual(inventory.dispositionCounts, {
    'measured-runtime': 1,
    'measured-declaration': 0,
    'owner-suite-source-mapped': 1,
    'unmapped-runtime-source': 1,
    'build-type-export-contract': 1,
  });
  assert.deepEqual(inventory.unmeasuredRunnableEntrypoints, [
    'apps/api/src/main.ts',
  ]);
  assert.deepEqual(inventory.files[1].coverage, [
    {
      cohort: 'api',
      statementLocations: 2,
      hitStatementLocations: 1,
    },
  ]);
  assert.equal(inventory.files[1].registeredUncovered, 2);
  assert.deepEqual(inventory.files[2].ownerTestSuites, [
    'apps/api/test/owned.test.ts',
  ]);
  assert.match(inventory.sourceFingerprint, /^sha256:[0-9a-f]{64}$/u);
});

test('maps exact test suites through static relative imports', () => {
  const sources = new Map([
    ['apps/api/src/direct.ts', 'export const direct = true;\n'],
    ['apps/api/src/transitive.ts', 'export const transitive = true;\n'],
  ]);
  const tests = new Map([
    [
      'apps/api/test/feature.test.ts',
      "import '../src/direct.js'; import './support.js';\n",
    ],
    [
      'apps/api/test/support.ts',
      "export { transitive } from '../src/transitive.js';\n",
    ],
  ]);

  assert.deepEqual(
    mapSourceTestSuites({ sources, tests }),
    new Map([
      ['apps/api/src/transitive.ts', ['apps/api/test/feature.test.ts']],
      ['apps/api/src/direct.ts', ['apps/api/test/feature.test.ts']],
    ]),
  );
});

test('enumerates only package source trees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-source-inventory-'));
  try {
    await mkdir(path.join(root, 'apps', 'api', 'src'), { recursive: true });
    await mkdir(path.join(root, 'apps', 'api', 'test'), { recursive: true });
    await writeFile(path.join(root, 'apps', 'api', 'src', 'main.ts'), 'main');
    await writeFile(
      path.join(root, 'apps', 'api', 'test', 'main.test.ts'),
      'test',
    );

    assert.deepEqual(await sourceFilesInCollection(root, 'apps'), [
      path.join(root, 'apps', 'api', 'src', 'main.ts'),
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});
