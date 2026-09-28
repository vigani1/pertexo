import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
import { workflowGraphSchema } from '@pertexo/contracts/schemas/workflow-authoring';

// Test-control messages contain only result identifiers and command keys, never
// authentication cookies, verification URLs or raw session credentials.
export const receiptRecoveryEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  nodeId: z.uuid(),
  runId: z.uuid(),
  publishKey: z.uuid(),
  runKey: z.uuid(),
  deadlineAt: z.iso.datetime(),
});
export const runRecoveryEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  conditionId: z.uuid(),
  failedRunId: z.uuid(),
  replayRunId: z.uuid(),
  waitWorkflowId: z.uuid(),
  waitVersionId: z.uuid(),
  waitNodeId: z.uuid(),
  waitRunId: z.uuid(),
});

/** Durable receipts and outcomes after actual browser/server response loss. */
export async function verifyReceiptRecoveryEvidence(
  database: Pool,
  evidence: z.infer<typeof receiptRecoveryEvidenceSchema>,
) {
  const versions = await database.query<{ id: string; graph_json: unknown }>(
    'select id,graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(versions.rows).toHaveLength(1);
  expect(versions.rows[0]?.id).toBe(evidence.workflowVersionId);
  expect(
    workflowGraphSchema.parse(versions.rows[0]?.graph_json).nodes[0],
  ).toMatchObject({
    id: evidence.nodeId,
    label: 'Receipt source',
    inputMappings: { proof: { kind: 'run_input', path: '$.proof' } },
  });
  const draft = await database.query<{ graph_json: unknown }>(
    'select graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(draft.rows).toHaveLength(1);
  expect(
    workflowGraphSchema.parse(draft.rows[0]?.graph_json).nodes[0]?.label,
  ).toBe('Newer unpublished name');
  const runs = await database.query<{
    id: string;
    status: string;
    workflow_version_id: string;
    deadline_at: Date;
  }>(
    'select id,status,workflow_version_id,deadline_at from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(runs.rows).toHaveLength(1);
  expect(runs.rows[0]).toMatchObject({
    id: evidence.runId,
    status: 'succeeded',
    workflow_version_id: evidence.workflowVersionId,
  });
  expect(runs.rows[0]?.deadline_at.toISOString()).toBe(evidence.deadlineAt);
  const receipts = await database.query<{
    operation: string;
    status: string;
    key_hash: string;
    resource_id: string;
  }>(
    `select operation,status,key_hash,resource_id from app.idempotency_records
     where workspace_id=$1 and resource_id=any($2::uuid[])
       and operation in ('workflow.publish','workflow.run.accept') order by operation`,
    [evidence.workspaceId, [evidence.workflowId, evidence.runId]],
  );
  expect(receipts.rows).toEqual([
    {
      operation: 'workflow.publish',
      status: 'completed',
      key_hash: createHash('sha256').update(evidence.publishKey).digest('hex'),
      resource_id: evidence.workflowId,
    },
    {
      operation: 'workflow.run.accept',
      status: 'completed',
      key_hash: createHash('sha256').update(evidence.runKey).digest('hex'),
      resource_id: evidence.runId,
    },
  ]);
  const audits = await database.query<{ action: string; count: number }>(
    `select action,count(*)::int as count from app.audit_events
     where workspace_id=$1 and target_id=any($2::uuid[])
       and action in ('workflow.published','workflow.run.started') group by action order by action`,
    [evidence.workspaceId, [evidence.workflowId, evidence.runId]],
  );
  expect(audits.rows).toEqual([
    { action: 'workflow.published', count: 1 },
    { action: 'workflow.run.started', count: 1 },
  ]);
  const nodes = await database.query<{
    node_id: string;
    status: string;
    current_attempt_number: number;
  }>(
    'select node_id,status,current_attempt_number from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
    [evidence.workspaceId, evidence.runId],
  );
  expect(nodes.rows).toEqual([
    {
      node_id: evidence.nodeId,
      status: 'succeeded',
      current_attempt_number: 1,
    },
  ]);
}

/** Pure execution/replay/cancellation is qualified by durable terminal state. */
export async function verifyRunRecoveryEvidence(
  database: Pool,
  evidence: z.infer<typeof runRecoveryEvidenceSchema>,
) {
  const runs = await database.query<{
    id: string;
    status: string;
    workflow_id: string;
    workflow_version_id: string;
    replay_source_run_id: string | null;
    cancel_requested_at: Date | null;
  }>(
    `select id,status,workflow_id,workflow_version_id,replay_source_run_id,cancel_requested_at
     from app.workflow_runs where workspace_id=$1 and workflow_id=any($2::uuid[])`,
    [evidence.workspaceId, [evidence.workflowId, evidence.waitWorkflowId]],
  );
  expect(runs.rows).toHaveLength(3);
  expect(runs.rows.find(({ id }) => id === evidence.failedRunId)).toMatchObject(
    {
      status: 'failed',
      workflow_id: evidence.workflowId,
      workflow_version_id: evidence.workflowVersionId,
      replay_source_run_id: null,
      cancel_requested_at: null,
    },
  );
  expect(runs.rows.find(({ id }) => id === evidence.replayRunId)).toMatchObject(
    {
      status: 'succeeded',
      workflow_id: evidence.workflowId,
      workflow_version_id: evidence.workflowVersionId,
      replay_source_run_id: evidence.failedRunId,
      cancel_requested_at: null,
    },
  );
  const canceled = runs.rows.find(({ id }) => id === evidence.waitRunId);
  expect(canceled).toMatchObject({
    status: 'canceled',
    workflow_id: evidence.waitWorkflowId,
    workflow_version_id: evidence.waitVersionId,
    replay_source_run_id: null,
  });
  expect(canceled?.cancel_requested_at).toBeInstanceOf(Date);
  const versions = await database.query<{ id: string }>(
    'select id from app.workflow_versions where workspace_id=$1 and workflow_id=any($2::uuid[])',
    [evidence.workspaceId, [evidence.workflowId, evidence.waitWorkflowId]],
  );
  expect(versions.rows).toHaveLength(2);
  expect(versions.rows.map(({ id }) => id)).toEqual(
    expect.arrayContaining([
      evidence.workflowVersionId,
      evidence.waitVersionId,
    ]),
  );
  const nodes = await database.query<{
    workflow_run_id: string;
    node_id: string;
    status: string;
    safe_error_code: string | null;
    current_attempt_number: number;
  }>(
    `select workflow_run_id,node_id,status,safe_error_code,current_attempt_number from app.node_runs
     where workspace_id=$1 and workflow_run_id=any($2::uuid[])`,
    [
      evidence.workspaceId,
      [evidence.failedRunId, evidence.replayRunId, evidence.waitRunId],
    ],
  );
  expect(nodes.rows).toHaveLength(3);
  expect(
    nodes.rows.find(
      ({ workflow_run_id }) => workflow_run_id === evidence.failedRunId,
    ),
  ).toMatchObject({
    node_id: evidence.conditionId,
    status: 'failed',
    safe_error_code: 'execution.attempt_invalid',
    current_attempt_number: 1,
  });
  expect(
    nodes.rows.find(
      ({ workflow_run_id }) => workflow_run_id === evidence.replayRunId,
    ),
  ).toMatchObject({
    node_id: evidence.conditionId,
    status: 'succeeded',
    current_attempt_number: 1,
  });
  expect(
    nodes.rows.find(
      ({ workflow_run_id }) => workflow_run_id === evidence.waitRunId,
    ),
  ).toMatchObject({
    node_id: evidence.waitNodeId,
    status: 'canceled',
    current_attempt_number: 1,
  });
  const cancellations = await database.query<{ type: string; count: number }>(
    `select type,count(*)::int as count from app.run_events where workspace_id=$1 and workflow_run_id=$2
     and type in ('run.cancel_requested','run.canceled') group by type order by type collate "C"`,
    [evidence.workspaceId, evidence.waitRunId],
  );
  expect(cancellations.rows).toEqual([
    { type: 'run.cancel_requested', count: 1 },
    { type: 'run.canceled', count: 1 },
  ]);
  const cancellationAudit = await database.query<{ count: number }>(
    `select count(*)::int as count from app.audit_events where workspace_id=$1
     and target_id=$2 and action='workflow.run.cancel_requested'`,
    [evidence.workspaceId, evidence.waitRunId],
  );
  expect(cancellationAudit.rows).toEqual([{ count: 1 }]);
}
