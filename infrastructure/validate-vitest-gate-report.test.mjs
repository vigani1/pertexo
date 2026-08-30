import assert from 'node:assert/strict';
import test from 'node:test';

import { validateVitestGateReport } from './validate-vitest-gate-report.mjs';

const passingReport = Object.freeze({
  numFailedTests: 0,
  numPassedTests: 2,
  numPendingTests: 0,
  numTotalTests: 2,
  success: true,
});

test('accepts a successful required gate with no skipped tests', () => {
  assert.deepEqual(
    validateVitestGateReport(passingReport, 'required API gates'),
    {
      passed: 2,
      total: 2,
    },
  );
});

test('rejects a required gate that executed no tests', () => {
  assert.throws(
    () =>
      validateVitestGateReport(
        {
          ...passingReport,
          numPassedTests: 0,
          numTotalTests: 0,
        },
        'required API gates',
      ),
    /executed zero/u,
  );
});

test('rejects skipped tests even when another required test passed', () => {
  assert.throws(
    () =>
      validateVitestGateReport(
        {
          ...passingReport,
          numPassedTests: 1,
          numPendingTests: 1,
        },
        'required API gates',
      ),
    /skipped or pending/u,
  );
});
