import assert from 'node:assert/strict';
import test from 'node:test';

import { uncoveredBranches } from './report-risk-coverage.mjs';

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
      classification: 'testable',
    },
  ]);
});
