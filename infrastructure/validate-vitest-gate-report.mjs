/* global process */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function assertCount(report, field) {
  const value = report[field];
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Vitest gate report has invalid ${field}`);
  return value;
}

export function validateVitestGateReport(report, gateName) {
  if (report === null || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Vitest gate report must be an object');
  const passed = assertCount(report, 'numPassedTests');
  const failed = assertCount(report, 'numFailedTests');
  const pending = assertCount(report, 'numPendingTests');
  const total = assertCount(report, 'numTotalTests');
  if (report.success !== true || failed !== 0)
    throw new Error(`${gateName} reported failed tests`);
  if (passed === 0 || total === 0)
    throw new Error(`${gateName} executed zero passing tests`);
  if (pending !== 0 || passed !== total)
    throw new Error(`${gateName} contains skipped or pending tests`);
  return { passed, total };
}

async function main() {
  const [reportPath, gateName = 'required integration gate'] =
    process.argv.slice(2);
  if (!reportPath)
    throw new Error(
      'usage: node infrastructure/validate-vitest-gate-report.mjs <report.json> [gate-name]',
    );
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const result = validateVitestGateReport(report, gateName);
  process.stdout.write(
    `${gateName}: ${result.passed}/${result.total} tests passed; none skipped.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
