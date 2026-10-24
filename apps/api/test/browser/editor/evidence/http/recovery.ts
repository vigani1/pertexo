import type { Pool } from 'pg';
import { expect } from 'vitest';
import type { z } from 'zod';

import type { httpEvidenceSchema } from './scope.js';
import { hash } from './scope.js';

export async function verifyFailedStepRecovery(
  database: Pool,
  evidence: z.infer<typeof httpEvidenceSchema>,
) {
  const { failedRunId, recoveryRunId, unknownRunId, recoveryKey } =
    evidence.recovery;
  const runs = await database.query(
    `select id,status,replay_source_run_id,recovery_reused_count,recovery_effect_risk,recovery_effects_acknowledged
    from app.workflow_runs where workspace_id=$1 and workflow_id=$2`,
    [evidence.workspaceId, evidence.workflowId],
  );
  expect(runs.rows).toHaveLength(8);
  expect(runs.rows.find(({ id }) => id === failedRunId)).toMatchObject({
    status: 'failed',
    recovery_reused_count: null,
  });
  expect(runs.rows.find(({ id }) => id === unknownRunId)).toMatchObject({
    status: 'outcome_unknown',
    recovery_reused_count: null,
  });
  expect(runs.rows.find(({ id }) => id === recoveryRunId)).toMatchObject({
    status: 'succeeded',
    replay_source_run_id: failedRunId,
    recovery_reused_count: 4,
    recovery_effects_acknowledged: true,
  });
  for (const [sourceId, recoveredId] of [
    [evidence.recovery.unknownRunId, evidence.recovery.unknownRecoveryRunId],
    [evidence.recovery.networkRunId, evidence.recovery.networkRecoveryRunId],
  ]) {
    expect(runs.rows.find(({ id }) => id === sourceId)).toMatchObject({
      status: 'outcome_unknown',
      recovery_reused_count: null,
    });
    expect(runs.rows.find(({ id }) => id === recoveredId)).toMatchObject({
      status: 'succeeded',
      replay_source_run_id: sourceId,
      recovery_reused_count: 4,
      recovery_effect_risk: 'unknown_outcome',
      recovery_effects_acknowledged: true,
    });
    const proof = await database.query(
      `select
      recovered.workflow_version_id=source.workflow_version_id same_version,
      recovered.input_ref::jsonb=source.input_ref::jsonb same_input,
      (select count(*)::int from app.node_runs node where node.workspace_id=recovered.workspace_id and node.workflow_run_id=recovered.id
        and node.reused_source_run_id=source.id and node.current_attempt_id is null) copies,
      (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id where node.workspace_id=recovered.workspace_id and node.workflow_run_id=source.id) source_attempts,
      (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id where node.workspace_id=recovered.workspace_id and node.workflow_run_id=recovered.id) new_attempts,
      (select count(*)::int from app.audit_events audit where audit.workspace_id=recovered.workspace_id and audit.action='workflow.run.recovered'
        and audit.metadata->>'sourceRunId'=source.id::text and audit.metadata->>'acknowledgeUnknownOutcome'='true') acknowledged_audits
      from app.workflow_runs recovered join app.workflow_runs source on source.workspace_id=recovered.workspace_id and source.id=$3
      where recovered.workspace_id=$1 and recovered.id=$2`,
      [evidence.workspaceId, recoveredId, sourceId],
    );
    expect(proof.rows).toEqual([
      {
        same_version: true,
        same_input: true,
        copies: 4,
        source_attempts: 5,
        new_attempts: 2,
        acknowledged_audits: 1,
      },
    ]);
  }
  const copies = await database.query(
    `select node.id,node.node_id,node.current_attempt_number,node.started_at,node.completed_at,node.reused_source_run_id,
    (select count(*)::int from app.node_attempts attempt where attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id) attempts
    from app.node_runs node where node.workspace_id=$1 and node.workflow_run_id=$2 and node.reused_source_run_id is not null`,
    [evidence.workspaceId, recoveryRunId],
  );
  expect(copies.rows).toHaveLength(4);
  for (const copy of copies.rows)
    expect(copy).toMatchObject({
      current_attempt_number: null,
      started_at: null,
      completed_at: null,
      reused_source_run_id: failedRunId,
      attempts: 0,
    });
  const target = await database.query<{
    id: string;
    workflow_run_id: string;
    provider_dispatch_binding: unknown;
  }>(
    `select node.id,node.workflow_run_id,attempt.status,attempt.side_effect_class,attempt.dispatch_marked_at is not null dispatched,attempt.executor_failure_kind,
    node.provider_dispatch_binding from app.node_runs node join app.node_attempts attempt on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id
    where node.workspace_id=$1 and node.node_id=$2 and node.workflow_run_id=any($3::uuid[])`,
    [
      evidence.workspaceId,
      evidence.httpId,
      [failedRunId, recoveryRunId, unknownRunId],
    ],
  );
  expect(target.rows).toHaveLength(3);
  expect(
    target.rows.find(({ workflow_run_id }) => workflow_run_id === failedRunId),
  ).toMatchObject({
    status: 'failed',
    side_effect_class: 'unsafe',
    dispatched: true,
    executor_failure_kind: 'failed',
  });
  expect(
    target.rows.find(
      ({ workflow_run_id }) => workflow_run_id === recoveryRunId,
    ),
  ).toMatchObject({
    status: 'succeeded',
    side_effect_class: 'unsafe',
    dispatched: true,
    executor_failure_kind: null,
  });
  expect(
    target.rows.find(({ workflow_run_id }) => workflow_run_id === unknownRunId),
  ).toMatchObject({
    status: 'failed',
    dispatched: true,
    executor_failure_kind: 'outcome_unknown',
  });
  expect(
    target.rows.find(({ workflow_run_id }) => workflow_run_id === recoveryRunId)
      ?.provider_dispatch_binding,
  ).toEqual(
    target.rows.find(({ workflow_run_id }) => workflow_run_id === failedRunId)
      ?.provider_dispatch_binding,
  );
  expect(
    target.rows.find(({ workflow_run_id }) => workflow_run_id === recoveryRunId)
      ?.id,
  ).not.toBe(
    target.rows.find(({ workflow_run_id }) => workflow_run_id === failedRunId)
      ?.id,
  );
  const receipt = await database.query(
    `select resource_id,status from app.idempotency_records where workspace_id=$1 and operation='workflow.run.accept' and key_hash=$2`,
    [evidence.workspaceId, hash(recoveryKey)],
  );
  expect(receipt.rows).toEqual([
    { resource_id: recoveryRunId, status: 'completed' },
  ]);
}
