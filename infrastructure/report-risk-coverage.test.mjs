import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRiskCoverageReport,
  uncoveredBranches,
} from './report-risk-coverage.mjs';

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
  const review = {
    cohort: 'api',
    file: 'apps/api/src/generated.ts',
    branchType: 'cond-expr',
    line: 12,
    column: 4,
    classification: 'generated',
    justification: 'Compiler-generated decorator fallback is not callable.',
  };

  const report = createRiskCoverageReport(reports, '/repo', new Date(0), [
    review,
  ]);
  assert.equal(report.classification.status, 'reviewed');
  assert.equal(report.classification.reviewedCount, 1);
  assert.equal(report.classification.unreviewedCount, 0);
  assert.deepEqual(report.uncoveredBranches[0], {
    ...review,
    reviewStatus: 'reviewed',
  });

  assert.throws(
    () =>
      createRiskCoverageReport(reports, '/repo', new Date(0), [
        { ...review, line: 13 },
      ]),
    /Stale risk-coverage reviews/u,
  );
});
