import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRiskCoverageReport,
  flattenRiskCoverageReviewGroups,
  uncoveredBranches,
} from './report-risk-coverage.mjs';

test('flattens source-grouped manifest reviews without repeating locators', () => {
  const review = {
    branchId: '7',
    locationIndex: 0,
    branchType: 'if',
    line: 42,
    column: 2,
    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    classification: 'defensive',
    justification: 'The guard rejects a structurally invalid persisted value.',
  };

  assert.deepEqual(
    flattenRiskCoverageReviewGroups([
      {
        cohort: 'database',
        file: 'packages/database/src/workspace.ts',
        reviews: [review],
      },
    ]),
    [
      {
        cohort: 'database',
        file: 'packages/database/src/workspace.ts',
        ...review,
      },
    ],
  );
  assert.throws(
    () =>
      flattenRiskCoverageReviewGroups([
        { cohort: 'database', file: 'same.ts', reviews: [] },
        { cohort: 'database', file: 'same.ts', reviews: [] },
      ]),
    /Duplicate risk-coverage review group/u,
  );
});

test('reports each uncovered branch location with its risk cohort', () => {
  const report = {
    '/repo/security.ts': {
      branchMap: {
        0: {
          type: 'if',
          locations: [
            { start: { line: 10, column: 2 } },
            { start: { line: 12, column: 2 } },
          ],
        },
      },
      b: { 0: [3, 0] },
    },
  };
  assert.deepEqual(uncoveredBranches(report, 'security'), [
    {
      cohort: 'security',
      file: '/repo/security.ts',
      branchId: '0',
      locationIndex: 1,
      branchType: 'if',
      line: 12,
      column: 2,
      reviewStatus: 'unreviewed',
    },
  ]);
});

test('describes only the exact selected files without claiming classification', () => {
  const report = createRiskCoverageReport(
    new Map([
      [
        'database',
        {
          '/repo/packages/database/src/workspace.ts': {
            branchMap: {},
            b: {},
          },
        },
      ],
    ]),
    '/repo',
  );
  assert.deepEqual(report.scope, {
    kind: 'selected-critical-module-files',
    cohorts: [
      {
        cohort: 'database',
        files: ['packages/database/src/workspace.ts'],
      },
    ],
  });
  assert.equal(report.classification.status, 'unreviewed');
  assert.equal(report.classification.reviewedCount, 0);
  assert.equal(report.classification.unreviewedCount, 0);
});

test('attaches exact durable reviews and rejects stale review locations', () => {
  const reports = new Map([
    [
      'api',
      {
        '/repo/apps/api/src/generated.ts': {
          branchMap: {
            0: {
              type: 'cond-expr',
              locations: [{ start: { line: 12, column: 4 } }],
            },
          },
          b: { 0: [0] },
        },
      },
    ],
  ]);
  const sources = new Map([
    [
      '/repo/apps/api/src/generated.ts',
      `${'\n'.repeat(11)}const value = true;\n`,
    ],
  ]);
  const unreviewed = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    [],
    {},
    sources,
  );
  const review = {
    cohort: 'api',
    file: 'apps/api/src/generated.ts',
    branchId: '0',
    locationIndex: 0,
    branchType: 'cond-expr',
    line: 12,
    column: 4,
    sourceFingerprint: unreviewed.uncoveredBranches[0].sourceFingerprint,
    classification: 'generated',
    justification: 'Compiler-generated decorator fallback is not callable.',
  };

  const report = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    [review],
    {},
    sources,
  );
  assert.equal(report.classification.status, 'reviewed');
  assert.equal(report.classification.reviewedCount, 1);
  assert.equal(report.classification.unreviewedCount, 0);
  assert.deepEqual(report.uncoveredBranches[0], {
    ...review,
    reviewStatus: 'reviewed',
  });

  assert.throws(
    () =>
      createRiskCoverageReport(
        reports,
        '/repo',
        new Date(0),
        [{ ...review, line: 13 }],
        {},
        sources,
      ),
    /Stale risk-coverage reviews/u,
  );
});

test('reviews distinct instrumentation branches at the same source location', () => {
  const reports = new Map([
    [
      'worker',
      {
        '/repo/apps/worker/src/generated.ts': {
          branchMap: {
            7: {
              type: 'branch',
              locations: [{ start: { line: 0, column: 0 } }],
            },
            8: {
              type: 'branch',
              locations: [{ start: { line: 0, column: 0 } }],
            },
          },
          b: { 7: [0], 8: [0] },
        },
      },
    ],
  ]);
  const sharedReview = {
    cohort: 'worker',
    file: 'apps/worker/src/generated.ts',
    branchType: 'branch',
    line: 0,
    column: 0,
    locationIndex: 0,
    sourceFingerprint: '',
    classification: 'generated',
    justification: 'V8 emitted this branch without a source-level decision.',
  };

  const sources = new Map([
    ['/repo/apps/worker/src/generated.ts', 'const generated = true;\n'],
  ]);
  const branches = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    [],
    {},
    sources,
  ).uncoveredBranches;
  const report = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    branches.map((branch) => ({
      ...sharedReview,
      branchId: branch.branchId,
      sourceFingerprint: branch.sourceFingerprint,
    })),
    {},
    sources,
  );

  assert.equal(report.classification.reviewedCount, 2);
  assert.equal(report.classification.unreviewedCount, 0);
});

test('accepts an exact integration-covered branch review', () => {
  const reports = new Map([
    [
      'worker',
      {
        '/repo/apps/worker/src/adapter.ts': {
          branchMap: {
            3: {
              type: 'cond-expr',
              locations: [{ start: { line: 20, column: 4 } }],
            },
          },
          b: { 3: [0] },
        },
      },
    ],
  ]);
  const review = {
    cohort: 'worker',
    file: 'apps/worker/src/adapter.ts',
    branchId: '3',
    locationIndex: 0,
    branchType: 'cond-expr',
    line: 20,
    column: 4,
    sourceFingerprint: 'sha256:' + 'a'.repeat(64),
    classification: 'integration',
    evidenceId: 'worker-adapter-integration',
    justification:
      'The database-backed adapter path is exercised by the named integration suite.',
  };
  const evidence = {
    'worker-adapter-integration': {
      command: 'pnpm --filter @pertexo/worker test:integration',
      testFile: 'apps/worker/test/adapter.integration.test.ts',
      testName: 'worker adapter integration',
    },
  };
  const sources = new Map([
    [
      '/repo/apps/worker/src/adapter.ts',
      `${'\n'.repeat(19)}if (ready) run();\n`,
    ],
  ]);
  const unreviewed = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    [],
    evidence,
    sources,
  );
  review.sourceFingerprint = unreviewed.uncoveredBranches[0].sourceFingerprint;
  const report = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    [review],
    evidence,
    sources,
  );
  assert.equal(report.classification.reviewedCount, 1);
  assert.equal(report.classification.unreviewedCount, 0);

  assert.throws(
    () =>
      createRiskCoverageReport(
        reports,
        '/repo',
        new Date(0),
        [review],
        {},
        sources,
      ),
    /Missing integration evidence/u,
  );
});

test('rejects a review after source semantics change at the same location', () => {
  const reports = new Map([
    [
      'api',
      {
        '/repo/apps/api/src/policy.ts': {
          branchMap: {
            0: {
              type: 'if',
              loc: {
                start: { line: 1, column: 0 },
                end: { line: 1, column: 28 },
              },
              locations: [
                {
                  start: { line: 1, column: 0 },
                  end: { line: 1, column: 28 },
                },
              ],
            },
          },
          b: { 0: [0] },
        },
      },
    ],
  ]);
  const originalSources = new Map([
    ['/repo/apps/api/src/policy.ts', 'if (isAllowed) return value;\n'],
  ]);
  const initial = createRiskCoverageReport(
    reports,
    '/repo',
    new Date(0),
    [],
    {},
    originalSources,
  );
  const branch = initial.uncoveredBranches[0];
  const review = {
    cohort: branch.cohort,
    file: branch.file,
    branchId: branch.branchId,
    locationIndex: branch.locationIndex,
    branchType: branch.branchType,
    line: branch.line,
    column: branch.column,
    sourceFingerprint: branch.sourceFingerprint,
    classification: 'defensive',
    justification:
      'The authorization fallback deliberately rejects an unavailable policy decision.',
  };

  assert.equal(
    createRiskCoverageReport(
      reports,
      '/repo',
      new Date(0),
      [review],
      {},
      originalSources,
    ).classification.reviewedCount,
    1,
  );
  assert.throws(
    () =>
      createRiskCoverageReport(
        reports,
        '/repo',
        new Date(0),
        [review],
        {},
        new Map([
          ['/repo/apps/api/src/policy.ts', 'if (isDenied) return value;\n'],
        ]),
      ),
    /Stale risk-coverage source fingerprint/u,
  );
});
