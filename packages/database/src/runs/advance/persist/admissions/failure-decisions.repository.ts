import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../contract.js';
import type { PendingCoordinatorFailure } from '../../load/state.queries.js';

import type { RunTransitionPlan } from '../../plan.js';

export async function persistPendingFailureDecisions(
  client: PoolClient,
  plan: RunTransitionPlan,
  {
    pendingFailures,
    workspaceId,
    runId,
  }: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    workspaceId: string;
    runId: string;
  }>,
): Promise<void> {
  const invocations = new Map(
    [...plan.checkpoint.invocations, ...(plan.prunedInvocations ?? [])].map(
      (invocation) => [invocation.invocationKey, invocation],
    ),
  );
  const decisionEvents = new Map(
    plan.events.flatMap((event) =>
      event.invocationKey !== undefined &&
      [
        'node.retry_scheduled',
        'node.failed',
        'node.canceled',
        'node.timed_out',
        'node.outcome_unknown',
      ].includes(event.name)
        ? [[event.invocationKey, event] as const]
        : [],
    ),
  );
  for (const failure of pendingFailures) {
    const event = decisionEvents.get(failure.invocation_key);
    if (event === undefined || !invocations.has(failure.invocation_key))
      throw new CoordinatorRunStateCorruptError();
    const decision =
      event.name === 'node.retry_scheduled'
        ? 'retry'
        : event.name.slice('node.'.length);
    if (
      !['retry', 'failed', 'canceled', 'timed_out', 'outcome_unknown'].includes(
        decision,
      )
    )
      throw new CoordinatorRunStateCorruptError();
    const finalized = await client.query(
      `update app.node_attempts
         set retry_decision=$3,updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and retry_decision='pending'`,
      [workspaceId, failure.attempt_id, decision],
    );
    if (finalized.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
    const nodeStatus = decision === 'retry' ? 'waiting' : decision;
    const updated = await client.query(
      `update app.node_runs
         set status=$4::varchar,retry_due_at=$5,resume_at=null,
             wait_kind=case when $4::varchar='waiting'
               then 'retry_backoff' else null end,
             due_wakeup_at=null,
             completed_at=case when $4::varchar='waiting'
               then null else clock_timestamp() end,
             safe_error_code=$6,updated_at=clock_timestamp()
         where workspace_id=$1 and workflow_run_id=$2
           and invocation_key=$3 and current_attempt_id=$7
           and status='running'`,
      [
        workspaceId,
        runId,
        failure.invocation_key,
        nodeStatus,
        decision === 'retry' ? event.dueAt : null,
        failure.safe_error_code,
        failure.attempt_id,
      ],
    );
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}
