import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  coverageSourceFingerprint,
  createCoverageProducerManifest,
  validateCoverageProducerManifest,
} from './coverage-provenance.mjs';

import {
  classifySourceKind,
  createSourceInventory,
  mapSourceTestSuites,
  normalizedCoverageByFile,
  SOURCE_COVERAGE_COHORTS,
  sourceFilesInCollection,
} from './generate-coverage-evidence.mjs';

test('registers every app-owned entrypoint coverage cohort', () => {
  assert.deepEqual(
    SOURCE_COVERAGE_COHORTS.filter((cohort) => cohort.endsWith('-entrypoints')),
    [
      'api-entrypoints',
      'worker-entrypoints',
      'operator-command-entrypoints',
      'recovery-entrypoints',
      'retention-entrypoints',
    ],
  );
});

test('keeps service-gated coverage outside the standalone producer inventory', () => {
  assert.equal(SOURCE_COVERAGE_COHORTS.includes('database-integration'), false);
});

test('requires every package coverage producer to emit its cohort result', async () => {
  for (const [owner, cohort] of [
    ['workflow-model', 'workflow-model'],
    ['node-sdk', 'node-sdk'],
    ['node-catalog', 'node-catalog'],
    ['nodes-core', 'nodes-core'],
    ['observability', 'observability'],
    ['queue', 'queue'],
    ['rate-limit', 'rate-limit'],
  ]) {
    const manifest = JSON.parse(
      await readFile(`packages/${owner}/package.json`, 'utf8'),
    );
    assert.match(manifest.scripts['test:coverage'], /--reporter=json/u);
    assert.match(
      manifest.scripts['test:coverage'],
      new RegExp(
        `--outputFile\\.json=\\.\\./\\.\\./coverage/${cohort}/test-results\\.json`,
        'u',
      ),
    );
  }
});

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
            statementMap: { 0: {}, 1: {} },
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

test('requires actual entrypoint coverage rather than an owner-suite mapping', () => {
  const input = {
    artifactHashes: { coverage: [] },
    generatedAt: '2026-09-12T00:00:00.000Z',
    packageManager: 'pnpm@11.22.0',
    riskReport: {
      sourceRevision: `sha256:${'a'.repeat(64)}`,
      uncoveredBranches: [],
    },
    rootDirectory: '/repo',
    sources: new Map([
      ['apps/api/src/main.ts', 'export async function bootstrap() {}\n'],
    ]),
    testSuitesBySource: new Map([
      ['apps/api/src/main.ts', ['apps/api/test/main.test.ts']],
    ]),
  };
  const mappedOnly = createSourceInventory({
    ...input,
    coverageReports: new Map(),
  });
  const measured = createSourceInventory({
    ...input,
    coverageReports: new Map([
      [
        'api-entrypoints',
        {
          '/repo/apps/api/src/main.ts': {
            statementMap: { 0: { start: { line: 1 } } },
            s: { 0: 1 },
          },
        },
      ],
    ]),
  });

  assert.equal(
    mappedOnly.files[0].measurementDisposition,
    'owner-suite-source-mapped',
  );
  assert.deepEqual(mappedOnly.unmeasuredRunnableEntrypoints, [
    'apps/api/src/main.ts',
  ]);
  assert.equal(measured.files[0].measurementDisposition, 'measured-runtime');
  assert.deepEqual(measured.unmeasuredRunnableEntrypoints, []);
});

test('rejects missing, mismatched, and invalid statement coverage', () => {
  for (const coverage of [
    { statementMap: { 0: {} } },
    { statementMap: { 0: {} }, s: {} },
    { statementMap: { 0: {} }, s: { 0: -1 } },
  ])
    assert.throws(
      () =>
        normalizedCoverageByFile(
          new Map([['api', { '/repo/main.ts': coverage }]]),
          '/repo',
        ),
      /Istanbul statement/u,
    );
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

function passingCoverageResult(overrides = {}) {
  return {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: 1_000,
    testResults: [
      {
        endTime: 1_010,
        assertionResults: [{ title: 'passes', status: 'passed' }],
      },
    ],
    ...overrides,
  };
}

function provenanceInput() {
  const result = passingCoverageResult();
  const resultBytes = Buffer.from(JSON.stringify(result));
  const sources = new Map([
    ['apps/api/src/main.ts', 'export const value = 1;\n'],
  ]);
  return {
    artifacts: new Map([
      [
        'api',
        {
          coverageBytes: Buffer.from('{"coverage":true}'),
          result,
          resultBytes,
        },
      ],
    ]),
    generatedAt: new Date(2_000).toISOString(),
    packageManager: 'pnpm@10.17.1',
    riskReport: { sourceRevision: `sha256:${'a'.repeat(64)}` },
    riskReportBytes: Buffer.from('{"risk":true}'),
    sourceWitness: {
      schemaVersion: 1,
      command: 'pnpm test:coverage',
      capturedAt: 900,
      sourceFingerprint: coverageSourceFingerprint(sources),
      sourceFiles: [...sources.keys()],
    },
    sources,
  };
}

test('coverage provenance binds passing results and artifact bytes to source', () => {
  const input = provenanceInput();
  const manifest = createCoverageProducerManifest(input);
  assert.equal(
    validateCoverageProducerManifest({ ...input, manifest }),
    manifest,
  );
  assert.throws(
    () =>
      validateCoverageProducerManifest({
        ...input,
        manifest,
        sources: new Map([
          ['apps/api/src/main.ts', 'export const value = 2;\n'],
        ]),
      }),
    /source witness does not match|does not match current source and artifacts/u,
  );
  const changedArtifacts = new Map(input.artifacts);
  changedArtifacts.set('api', {
    ...changedArtifacts.get('api'),
    coverageBytes: Buffer.from('{"coverage":false}'),
  });
  assert.throws(
    () =>
      validateCoverageProducerManifest({
        ...input,
        artifacts: changedArtifacts,
        manifest,
      }),
    /does not match current source and artifacts/u,
  );
});

test('coverage provenance rejects source captured after results or changed since capture', () => {
  const input = provenanceInput();
  assert.throws(
    () =>
      createCoverageProducerManifest({
        ...input,
        sourceWitness: { ...input.sourceWitness, capturedAt: 1_001 },
      }),
    /before the source witness/u,
  );
  assert.throws(
    () =>
      createCoverageProducerManifest({
        ...input,
        sources: new Map([
          ['apps/api/src/main.ts', 'export const value = 2;\n'],
        ]),
      }),
    /source witness does not match/u,
  );
});

test('root coverage starts by recording a source witness', async () => {
  const manifest = JSON.parse(
    await readFile(
      path.resolve(import.meta.dirname, '../..', 'package.json'),
      'utf8',
    ),
  );
  assert.equal(
    manifest.scripts['pretest:coverage'],
    'node infrastructure/coverage/record-coverage-source-witness.mjs',
  );
});

test('coverage provenance rejects failed, pending, and malformed results', () => {
  const input = provenanceInput();
  for (const result of [
    passingCoverageResult({
      success: false,
      numPassedTests: 0,
      numFailedTests: 1,
    }),
    passingCoverageResult({
      numPassedTests: 0,
      numPendingTests: 1,
    }),
    passingCoverageResult({ testResults: undefined }),
  ]) {
    const resultBytes = Buffer.from(JSON.stringify(result));
    assert.throws(
      () =>
        createCoverageProducerManifest({
          ...input,
          artifacts: new Map([
            [
              'api',
              {
                coverageBytes: Buffer.from('{}'),
                result,
                resultBytes,
              },
            ],
          ]),
        }),
      /failed|unexpected|Malformed|executed/u,
    );
  }
});
