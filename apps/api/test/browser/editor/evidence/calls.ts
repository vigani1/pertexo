import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
export const callsEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  parentWorkflowId: z.uuid(),
  childWorkflowId: z.uuid(),
  firstRunId: z.uuid(),
  secondRunId: z.uuid(),
  refusedRunId: z.uuid(),
});
export async function verifyCallsEvidence(
  database: Pool,
  evidence: z.infer<typeof callsEvidenceSchema>,
) {
  const calls = await database.query<{
    parent_run_id: string;
    child_run_id: string | null;
    status: string;
    result_ref: unknown;
    slot_lent: boolean;
    consumed: boolean;
    safe_error_code: string | null;
  }>(
    `select parent_run_id,child_run_id,status,result_ref,slot_lent,consumed_at is not null consumed,safe_error_code from app.workflow_calls where workspace_id=$1 and parent_run_id=any($2::uuid[])`,
    [
      evidence.workspaceId,
      [evidence.firstRunId, evidence.secondRunId, evidence.refusedRunId],
    ],
  );
  expect(calls.rows).toHaveLength(3);
  for (const [runId, value] of [
    [evidence.firstRunId, 'Ada'],
    [evidence.secondRunId, 'Ada!'],
  ])
    expect(
      calls.rows.find((call) => call.parent_run_id === runId),
    ).toMatchObject({
      status: 'succeeded',
      result_ref: { kind: 'inline', value },
      consumed: true,
      slot_lent: false,
    });
  expect(
    calls.rows.find((call) => call.parent_run_id === evidence.refusedRunId),
  ).toMatchObject({
    status: 'refused',
    child_run_id: null,
    safe_error_code: 'call_target_unavailable',
    slot_lent: false,
  });
  const children = await database.query<{
    id: string;
    trigger_type: string;
    status: string;
  }>(
    `select id,trigger_type,status from app.workflow_runs where workspace_id=$1 and workflow_id=$2`,
    [evidence.workspaceId, evidence.childWorkflowId],
  );
  expect(children.rows).toHaveLength(2);
  for (const child of children.rows)
    expect(child).toMatchObject({
      trigger_type: 'workflow_call',
      status: 'succeeded',
    });
  const dependencies = await database.query(
    `select dep.node_id from app.workflow_version_dependencies dep join app.workflows parent on parent.workspace_id=dep.workspace_id and parent.published_version_id=dep.parent_version_id where dep.workspace_id=$1 and parent.id=$2 and dep.target_workflow_id=$3`,
    [evidence.workspaceId, evidence.parentWorkflowId, evidence.childWorkflowId],
  );
  expect(dependencies.rows).toHaveLength(1);
  expect(
    (
      await database.query(
        'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
        [evidence.workspaceId],
      )
    ).rows,
  ).toEqual([]);
}
