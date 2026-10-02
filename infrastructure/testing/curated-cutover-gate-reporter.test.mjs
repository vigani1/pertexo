import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { nodeSummaryGateReport } from './curated-cutover-gate-reporter.mjs';
import { validateVitestGateReport } from '../coverage/validate-vitest-gate-report.mjs';

const summary = {
  success: true,
  counts: {
    tests: 10,
    passed: 10,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  },
};
test('actual Node cutover summaries preserve strict nonzero/no-skip validation', () => {
  assert.deepEqual(
    validateVitestGateReport(nodeSummaryGateReport(summary), 'cutover', 10),
    { passed: 10, total: 10 },
  );
  for (const key of ['skipped', 'cancelled', 'todo']) {
    const changed = structuredClone(summary);
    changed.counts.passed = 9;
    changed.counts[key] = 1;
    assert.throws(() =>
      validateVitestGateReport(nodeSummaryGateReport(changed), 'cutover', 10),
    );
  }
  for (const key of [
    'tests',
    'passed',
    'failed',
    'skipped',
    'cancelled',
    'todo',
  ]) {
    const changed = structuredClone(summary);
    changed.counts = Object.fromEntries(
      Object.entries(changed.counts).filter(([name]) => name !== key),
    );
    assert.throws(() => nodeSummaryGateReport(changed));
  }
});

test('real CLI reporter rejects the disabled cutover, not a passing file wrapper', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-cutover-reporter-unit-'),
  );
  const output = path.join(directory, 'cutover.json');
  const environment = {
    ...process.env,
    F06_CUTOVER_OWNED_FIXTURE: 'false',
    CURATED_CUTOVER_GATE_REPORT: output,
  };
  // This is a new CLI test runner, not a child file of this runner.
  delete environment.NODE_TEST_CONTEXT;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--test',
        '--test-reporter=./infrastructure/testing/curated-cutover-gate-reporter.mjs',
        'infrastructure/testing/curated-cutover.integration.test.mjs',
      ],
      {
        cwd: new URL('../../', import.meta.url),
        env: environment,
        timeout: 10000,
      },
    );
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.numTotalTests, 1);
    assert.equal(report.numPassedTests, 0);
    assert.equal(report.numPendingTests, 1);
    assert.throws(
      () => validateVitestGateReport(report, 'cutover', 10),
      /required passing tests/u,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
