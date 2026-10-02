import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export function nodeSummaryGateReport(summary) {
  if (
    summary === null ||
    typeof summary !== 'object' ||
    typeof summary.success !== 'boolean'
  )
    throw new Error('Cutover requires an actual Node test summary');
  const counts = summary.counts;
  for (const key of [
    'tests',
    'passed',
    'failed',
    'skipped',
    'todo',
    'cancelled',
  ])
    if (!Number.isSafeInteger(counts?.[key]) || counts[key] < 0)
      throw new Error('Cutover Node test summary has invalid counts');
  return {
    success: summary.success && counts.failed === 0 && counts.cancelled === 0,
    numTotalTests: counts.tests,
    numPassedTests: counts.passed,
    numFailedTests: counts.failed,
    numPendingTests: counts.skipped + counts.cancelled,
    numTodoTests: counts.todo,
  };
}

/** CLI reporter consumes the real test stream, never console-derived pass markers. */
export default async function* curatedCutoverGateReporter(events) {
  const output = process.env.CURATED_CUTOVER_GATE_REPORT;
  if (typeof output !== 'string' || !path.isAbsolute(output))
    throw new Error('Cutover requires an explicit absolute report path');
  let summary;
  for await (const event of events) {
    if (event.type === 'test:summary') summary = event.data;
    if (event.type === 'test:stdout' || event.type === 'test:stderr')
      yield event.data.message;
    if (event.type === 'test:fail')
      yield `Cutover test failed: ${event.data.name}\n`;
  }
  const report = nodeSummaryGateReport(summary);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  yield `Cutover actual Node counts: ${report.numPassedTests}/${report.numTotalTests} passed, ${report.numPendingTests} pending\n`;
}
