import type { PoolClient } from 'pg';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
} from './coordinator-run-store-contract.js';
import type { PersistedWorkflowCheckpoint } from './compatibility/persisted-workflow-checkpoint.js';

export async function persistLoopBarrierTransitions(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  current: PersistedWorkflowCheckpoint,
  next: PersistedWorkflowCheckpoint,
): Promise<void> {
  const currentLoops = new Set(
    current.loops.map(({ controlInvocationKey }) => controlInvocationKey),
  );
  const barriers = next.loops.filter(
    ({ controlInvocationKey }) => !currentLoops.has(controlInvocationKey),
  );
  if (barriers.length === 0) return;
  const updated = await client.query(
    `update app.node_runs
     set status='waiting', control_kind='for_each_barrier', completed_at=null,
         resume_at=null, retry_due_at=null, due_wakeup_at=null,
         updated_at=clock_timestamp()
     where workspace_id=$1 and workflow_run_id=$2
       and invocation_key=any($3::varchar[]) and status='succeeded'`,
    [
      workspaceId,
      runId,
      barriers.map(({ controlInvocationKey }) => controlInvocationKey),
    ],
  );
  if (updated.rowCount !== barriers.length)
    throw new CoordinatorRunStateCorruptError();
}

export async function persistDueReadyTransitions(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  current: PersistedWorkflowCheckpoint,
  next: PersistedWorkflowCheckpoint,
): Promise<void> {
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const transitions = next.invocations.filter(
    (invocation) =>
      invocation.status === 'ready' &&
      currentInvocations.get(invocation.invocationKey)?.status === 'waiting',
  );
  if (transitions.length === 0) return;
  const rows = await client.query<{
    current_attempt_number: number | null;
    invocation_key: string;
    is_due: boolean;
  }>(
    `select invocation_key, current_attempt_number,
            coalesce(retry_due_at,resume_at) is not null
              and coalesce(retry_due_at,resume_at) <= clock_timestamp() as is_due
     from app.node_runs
     where workspace_id=$1 and workflow_run_id=$2
       and invocation_key=any($3::varchar[]) and status='waiting'
     for update`,
    [workspaceId, runId, transitions.map(({ invocationKey }) => invocationKey)],
  );
  const physical = new Map(rows.rows.map((row) => [row.invocation_key, row]));
  if (
    transitions.some((transition) => {
      const row = physical.get(transition.invocationKey);
      return (
        row?.is_due !== true ||
        row.current_attempt_number !== transition.attemptNumber
      );
    })
  )
    throw new CoordinatorPlanInvalidError();
  const updated = await client.query(
    `update app.node_runs
     set status='ready', resume_at=null, retry_due_at=null, due_wakeup_at=null,
         wait_kind=null,
         updated_at=clock_timestamp()
     where workspace_id=$1 and workflow_run_id=$2
       and invocation_key=any($3::varchar[]) and status='waiting'`,
    [workspaceId, runId, transitions.map(({ invocationKey }) => invocationKey)],
  );
  if (updated.rowCount !== transitions.length)
    throw new CoordinatorRunStateCorruptError();
}
