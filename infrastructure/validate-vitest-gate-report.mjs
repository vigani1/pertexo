/* global process */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function assertCount(report, field) {
  const value = report[field];
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Vitest gate report has invalid ${field}`);
  return value;
}

export function validateVitestGateReport(
  report,
  gateName,
  minimumTests = 1,
  expectedPendingTests = 0,
) {
  if (report === null || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Vitest gate report must be an object');
  const passed = assertCount(report, 'numPassedTests');
  const failed = assertCount(report, 'numFailedTests');
  const pending = assertCount(report, 'numPendingTests');
  const todo = assertCount(report, 'numTodoTests');
  const total = assertCount(report, 'numTotalTests');
  if (!Number.isSafeInteger(minimumTests) || minimumTests < 1)
    throw new Error('Vitest gate minimum must be a positive integer');
  if (!Number.isSafeInteger(expectedPendingTests) || expectedPendingTests < 0)
    throw new Error('Vitest expected pending count must be nonnegative');
  if (report.success !== true || failed !== 0)
    throw new Error(`${gateName} reported failed tests`);
  if (passed < minimumTests || total < minimumTests)
    throw new Error(
      `${gateName} executed ${passed}/${minimumTests} required passing tests`,
    );
  if (
    pending !== expectedPendingTests ||
    todo !== 0 ||
    passed + pending !== total
  )
    throw new Error(
      `${gateName} contains unexpected skipped, pending, or todo tests`,
    );
  return { passed, total };
}

async function main() {
  const [
    reportPath,
    gateName = 'required integration gate',
    minimum = '1',
    expectedPending = '0',
  ] = process.argv.slice(2);
  if (!reportPath)
    throw new Error(
      'usage: node infrastructure/validate-vitest-gate-report.mjs <report.json> [gate-name] [minimum-tests] [expected-pending-tests]',
    );
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const result = validateVitestGateReport(
    report,
    gateName,
    Number(minimum),
    Number(expectedPending),
  );
  const pendingSummary =
    Number(expectedPending) === 0
      ? 'none skipped'
      : `${expectedPending} reviewed provider-specific tests pending`;
  process.stdout.write(
    `${gateName}: ${result.passed}/${result.total} tests passed; ${pendingSummary}.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
