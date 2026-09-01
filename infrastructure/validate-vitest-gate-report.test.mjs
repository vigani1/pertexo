import assert from 'node:assert/strict';
import test from 'node:test';

import { validateVitestGateReport } from './validate-vitest-gate-report.mjs';

const passingReport = Object.freeze({
  numFailedTests: 0,
  numPassedTests: 2,
  numPendingTests: 0,
  numTodoTests: 0,
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
    /executed 0\/1 required/u,
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
    /unexpected skipped, pending, or todo/u,
  );
});

test('accepts only an explicitly sized provider-specific pending set', () => {
  assert.deepEqual(
    validateVitestGateReport(
      {
        ...passingReport,
        numPassedTests: 5,
        numPendingTests: 3,
        numTotalTests: 8,
      },
      'MinIO artifact gates',
      5,
      3,
    ),
    { passed: 5, total: 8 },
  );
  assert.throws(
    () =>
      validateVitestGateReport(
        {
          ...passingReport,
          numPassedTests: 4,
          numPendingTests: 4,
          numTotalTests: 8,
        },
        'MinIO artifact gates',
        4,
        3,
      ),
    /unexpected skipped/u,
  );
});

test('rejects todo tests and an underfilled required cohort', () => {
  assert.throws(
    () =>
      validateVitestGateReport(
        { ...passingReport, numTodoTests: 1 },
        'required worker gates',
      ),
    /todo/u,
  );
  assert.throws(
    () => validateVitestGateReport(passingReport, 'required worker gates', 3),
    /2\/3 required/u,
  );
});
