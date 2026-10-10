import type { PoolClient } from 'pg';

import type { WorkflowCheckpoint } from '@pertexo/workflow-engine';

import { CoordinatorRunStateCorruptError } from '../contract.js';
import type { RunTransitionPlan } from '../plan.js';

/**
 * A For Each whose collection exceeded its limit fails the node that produced
 * the collection. That node already succeeded, so its row moves to failed here
 * instead of through the ordinary terminal update.
 */
export async function settleRejectedForEachDeclarations(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<ReadonlySet<string>> {
  const settled = new Set<string>();
  for (const event of plan.events) {
    if (
      event.name !== 'node.failed' ||
      event.reasonCode !== 'loop_limit_exceeded' ||
      event.invocationKey === undefined
    )
      continue;
    const updated = await client.query(
      `update app.node_runs
       set status='failed',output_ref=null,safe_error_code='loop_limit_exceeded',
           completed_at=clock_timestamp(),resume_at=null,retry_due_at=null,
           due_wakeup_at=null,wait_kind=null,updated_at=clock_timestamp()
       where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3
         and status='succeeded' and control_kind is null`,
      [workspaceId, runId, event.invocationKey],
    );
    if (updated.rowCount === 1) settled.add(event.invocationKey);
  }
  return settled;
}

export async function persistLoopBarrierTransitions(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  current: WorkflowCheckpoint,
  next: WorkflowCheckpoint,
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
  current: WorkflowCheckpoint,
  next: WorkflowCheckpoint,
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
