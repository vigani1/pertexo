import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nodeSummaryGateReport } from './curated-cutover-gate-reporter.mjs';

export default async function* inlineWorkflowCallGateReporter(events) {
  const output = process.env.INLINE_WORKFLOW_CALL_GATE_REPORT;
  if (typeof output !== 'string' || !path.isAbsolute(output))
    throw new Error(
      'Inline Call qualification requires an absolute report path',
    );
  let summary;
  for await (const event of events) {
    if (event.type === 'test:summary') summary = event.data;
    if (event.type === 'test:fail')
      yield `Inline Call qualification failed: ${event.data.name}\n`;
  }
  const report = nodeSummaryGateReport(summary);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  yield `Inline Call qualification: ${report.numPassedTests}/${report.numTotalTests} passed, ${report.numPendingTests} pending\n`;
}
