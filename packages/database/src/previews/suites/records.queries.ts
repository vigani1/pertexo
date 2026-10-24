import {
  workflowTestStepChoices,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import type {
  WorkflowTestSuiteSummary,
  WorkflowTestSuiteDetail,
  WorkflowTestSuiteReport,
} from '@pertexo/contracts';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { WorkflowTestError } from '../workflows/contract.js';
import type { SuiteRow, SuiteCaseRow } from './contract.js';
interface SummaryRow extends Pick<
  SuiteRow,
  | 'id'
  | 'started_by'
  | 'signature'
  | 'status'
  | 'stop_reason'
  | 'created_at'
  | 'completed_at'
  | 'expires_at'
> {
  draft_revision: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}
const summarySql = `select suite.id,suite.started_by,suite.signature,suite.status,suite.stop_reason,suite.created_at,suite.completed_at,suite.expires_at,snapshot.draft_revision,counts.*
 from app.workflow_test_suites suite join app.workflow_test_snapshots snapshot on snapshot.workspace_id=suite.workspace_id and snapshot.id=suite.snapshot_id
 cross join lateral(select count(*)::integer total,
  (count(*) filter(where entry.status='passed'))::integer passed,(count(*) filter(where entry.status='failed'))::integer failed,
  (count(*) filter(where entry.status='error'))::integer errors,(count(*) filter(where entry.status='skipped'))::integer skipped
  from app.workflow_test_suite_cases entry where entry.workspace_id=suite.workspace_id and entry.suite_id=suite.id) counts
 where suite.workspace_id=$1 and suite.workflow_id=$2 and suite.expires_at>clock_timestamp()`;
function summary(row: SummaryRow): WorkflowTestSuiteSummary {
  return {
    suiteId: row.id,
    startedBy: row.started_by,
    draftRevision: row.draft_revision,
    signature: row.signature,
    status: row.status,
    stopReason: row.stop_reason,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    errors: row.errors,
    skipped: row.skipped,
  };
}
export async function listSuites(
  client: PoolClient,
  input: SampleScope,
): Promise<readonly WorkflowTestSuiteSummary[]> {
  const found = await client.query<SummaryRow>(
    `with history as materialized(select id from app.workflow_test_suites where workspace_id=$1 and workflow_id=$2 and expires_at>clock_timestamp() order by (started_by=$3 and status='running') desc,created_at desc,id desc limit 20)
    ${summarySql.replace('from app.workflow_test_suites suite', 'from history join app.workflow_test_suites suite on suite.id=history.id')} order by (suite.started_by=$3 and suite.status='running') desc,suite.created_at desc,suite.id desc`,
    [input.workspaceId, input.workflowId, input.actorId],
  );
  return found.rows.map(summary);
}
export async function readSuite(
  client: PoolClient,
  input: SampleScope & { suiteId: string },
): Promise<WorkflowTestSuiteDetail> {
  const found = await client.query<SummaryRow>(
    `${summarySql} and suite.id=$3`,
    [input.workspaceId, input.workflowId, input.suiteId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new WorkflowTestError('not_found');
  const cases = await client.query<
    Pick<
      SuiteCaseRow,
      'ordinal' | 'case_id' | 'case_revision' | 'name' | 'status' | 'run_id'
    >
  >(
    'select ordinal,case_id,case_revision,name,status,run_id from app.workflow_test_suite_cases where workspace_id=$1 and suite_id=$2 order by ordinal limit 50',
    [input.workspaceId, input.suiteId],
  );
  return {
    ...summary(row),
    cases: cases.rows.map((entry) => ({
      ordinal: entry.ordinal,
      caseId: entry.case_id,
      caseRevision: entry.case_revision,
      name: entry.name,
      status: entry.status,
      runId: entry.run_id,
    })),
  };
}
export async function readCaseReport(
  client: PoolClient,
  input: SampleScope & { suiteId: string; ordinal: number },
): Promise<{
  report: WorkflowTestSuiteReport | null;
  stepLabels: Readonly<Record<string, string>>;
}> {
  const found = await client.query<{
    report: string | null;
    snapshot_id: string;
  }>(
    `select entry.report,suite.snapshot_id from app.workflow_test_suite_cases entry join app.workflow_test_suites suite on suite.workspace_id=entry.workspace_id and suite.id=entry.suite_id where entry.workspace_id=$1 and suite.workflow_id=$2 and suite.id=$3 and entry.ordinal=$4 and suite.expires_at>clock_timestamp()`,
    [input.workspaceId, input.workflowId, input.suiteId, input.ordinal],
  );
  const row = found.rows[0];
  if (row === undefined) throw new WorkflowTestError('not_found');
  const report =
    row.report === null
      ? null
      : (JSON.parse(row.report) as WorkflowTestSuiteReport);
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
      : (
          await client.query<{ graph_json: WorkflowGraph }>(
            'select graph_json from app.workflow_test_snapshots where workspace_id=$1 and id=$2',
            [input.workspaceId, row.snapshot_id],
          )
        ).rows[0];
  const labels =
    source === undefined
      ? []
      : workflowTestStepChoices(source.graph_json).filter((node) =>
          nodeIds.includes(node.nodeId),
        );
  return {
    report,
    stepLabels: Object.fromEntries(
      labels.map((node) => [node.nodeId, node.label]),
    ),
  };
}
