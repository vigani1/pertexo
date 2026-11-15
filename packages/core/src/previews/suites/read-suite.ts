import type { WorkflowActor } from '../../shared/workflow-actor.types.js';
import { decodeStoredValue } from '../../shared/stored-values.js';
import type {
  WorkflowTestSuiteDetail,
  WorkflowTestSuiteReport,
} from '@pertexo/contracts';
import {
  workflowTestStepChoices,
  workflowTestSuiteReportSchema,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { WorkflowTestError } from '../workflows/workflow-test.errors.js';
import {
  readCaseReportRow,
  readSnapshotGraph,
  readSuiteCaseRows,
  readSuiteRow,
  summary,
} from './test-suites.repository.js';

export async function readSuite(
  client: PoolClient,
  input: WorkflowActor & { suiteId: string },
): Promise<WorkflowTestSuiteDetail> {
  const row = await readSuiteRow(client, input);
  if (row === undefined) throw new WorkflowTestError('not_found');
  const cases = await readSuiteCaseRows(client, input);
  return { ...summary(row), cases };
}
export async function readCaseReport(
  client: PoolClient,
  input: WorkflowActor & { suiteId: string; ordinal: number },
): Promise<{
  report: WorkflowTestSuiteReport | null;
  stepLabels: Readonly<Record<string, string>>;
}> {
  const row = await readCaseReportRow(client, input);
  if (row === undefined) throw new WorkflowTestError('not_found');
  const storedReport = row.report;
  const report =
    storedReport === null
      ? null
      : decodeStoredValue(() =>
          workflowTestSuiteReportSchema.parse(JSON.parse(storedReport)),
        );
  const nodeIds = [
    ...new Set(
      report?.assertions.flatMap(({ assertion }) =>
        assertion.source.kind === 'step' ? [assertion.source.nodeId] : [],
      ) ?? [],
    ),
  ];
  const source =
    nodeIds.length === 0
      ? undefined
      : await readSnapshotGraph(client, input.workspaceId, row.snapshotId);
  const labels =
    source === undefined
      ? []
      : workflowTestStepChoices(source.graph).filter((node) =>
          nodeIds.includes(node.nodeId),
        );
  return {
    report,
    stepLabels: Object.fromEntries(
      labels.map((node) => [node.nodeId, node.label]),
    ),
  };
}
