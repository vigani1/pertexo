import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
import {
  testRunSql,
  retainedTestRunSql,
  runRetentionIntervalSql,
} from '../../runs/data-policy.js';
import type { PoolClient } from 'pg';

import type { SampleScope } from '../../authoring/step-samples/contract.js';
import {
  WorkflowTestError,
  type WorkflowTestDetail,
  type WorkflowTestSummary,
} from './contract.js';

interface TestRow {
  run_id: string;
  started_by: string | null;
  draft_revision: number;
  status: string;
  created_at: Date;
  expires_at: Date;
  graph_json: unknown;
  dispositions: WorkflowTestDetail['dispositions'];
}
function summary(row: TestRow): WorkflowTestSummary {
  return {
    runId: row.run_id,
    startedBy: row.started_by,
    draftRevision: row.draft_revision,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
export async function listTests(client: PoolClient, input: SampleScope) {
  const rows = await client.query<TestRow>(
    `select run.id run_id,snapshot.draft_revision,run.status,run.created_at,run.started_by,(run.created_at + ${bindResourcePredicate(runRetentionIntervalSql('run').inlineParams(), [])}) expires_at
    from app.workflow_test_snapshots snapshot join app.workflow_runs run on run.workspace_id=snapshot.workspace_id and run.workflow_version_id=snapshot.id
    where snapshot.workspace_id=$1 and run.workflow_id=$2 and ${bindResourcePredicate(testRunSql('run').inlineParams(), [])} and ${bindResourcePredicate(retainedTestRunSql('run').inlineParams(), [])} and snapshot.expires_at>clock_timestamp()
    order by (run.started_by=$3 and run.status in ('queued','running','waiting')) desc nulls last,run.created_at desc,run.id desc limit 20`,
    [input.workspaceId, input.workflowId, input.actorId],
  );
  return { items: rows.rows.map(summary) };
}
export async function readTestDetail(
  client: PoolClient,
  input: SampleScope & { runId: string },
): Promise<WorkflowTestDetail> {
  const rows = await client.query<TestRow>(
    `select run.id run_id,snapshot.draft_revision,(run.created_at + ${bindResourcePredicate(runRetentionIntervalSql('run').inlineParams(), [])}) expires_at,snapshot.graph_json,snapshot.dispositions,run.status,run.created_at,run.started_by
    from app.workflow_test_snapshots snapshot join app.workflow_runs run on run.workspace_id=snapshot.workspace_id and run.workflow_version_id=snapshot.id
    where snapshot.workspace_id=$1 and run.workflow_id=$2 and ${bindResourcePredicate(testRunSql('run').inlineParams(), [])} and ${bindResourcePredicate(retainedTestRunSql('run').inlineParams(), [])} and run.id=$3 and snapshot.expires_at>clock_timestamp()`,
    [input.workspaceId, input.workflowId, input.runId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new WorkflowTestError('not_found');
  return {
    ...summary(row),
    graph: row.graph_json,
    dispositions: row.dispositions,
  };
}
