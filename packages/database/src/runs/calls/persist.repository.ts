import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../advance/contract.js';
import {
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../advance/plan.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

/** Child facts never take the existing parent's run or checkpoint lock. */
export async function persistCallCompletion(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  if (
    !input.plan.events.some(
      ({ name }) =>
        name.startsWith('run.') && terminalRunStatuses.has(name.slice(4)),
    )
  )
    return;
  const failure = input.plan.events.find(
    ({ name }) => name === `run.${input.plan.checkpoint.runStatus}`,
  )?.reasonCode;
  const rows = await client.query<{ parent_run_id: string }>(
    `update app.workflow_calls set status=$3,result_ref=$4::json,safe_error_code=$5,completed_at=clock_timestamp()
     where workspace_id=$1 and child_run_id=$2 and status='accepted'
     returning parent_run_id`,
    [
      input.workspaceId,
      input.runId,
      input.plan.checkpoint.runStatus,
      input.plan.runResult === undefined
        ? null
        : JSON.stringify({ kind: 'inline', value: input.plan.runResult }),
      failure ?? null,
    ],
  );
  const missingCallResult =
    rows.rows.length > 0 &&
    input.plan.checkpoint.runStatus === 'succeeded' &&
    input.plan.runResult === undefined;
  if (missingCallResult) throw new CoordinatorRunStateCorruptError();
  for (const row of rows.rows)
    await wakeWorkflowRun(
      client,
      input.workspaceId,
      row.parent_run_id,
      input.traceparent,
    );
}

/** Logical Call output is the child result; SDK declaration output stays private. */
export async function persistConsumedCalls(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<void> {
  const settledKeys = plan.events.flatMap(({ name, invocationKey }) =>
    invocationKey !== undefined &&
    [
      'node.succeeded',
      'node.failed',
      'node.canceled',
      'node.timed_out',
      'node.outcome_unknown',
    ].includes(name)
      ? [invocationKey]
      : [],
  );
  for (const invocation of [
    ...plan.checkpoint.invocations,
    ...(plan.prunedInvocations ?? []),
  ]) {
    if (
      invocation.output?.kind !== 'call' ||
      !settledKeys.includes(invocation.invocationKey)
    )
      continue;
    const updated = await client.query(
      `update app.node_runs node set output_ref=call.result_ref
       from app.workflow_calls call
       where call.workspace_id=$1 and call.parent_run_id=$2 and call.id=$3
         and call.invocation_key=$4 and call.status='succeeded' and call.result_ref is not null
         and node.workspace_id=call.workspace_id and node.workflow_run_id=call.parent_run_id
         and node.invocation_key=call.invocation_key and node.status='succeeded'`,
      [workspaceId, runId, invocation.output.callId, invocation.invocationKey],
    );
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
  await client.query(
    `update app.workflow_calls set consumed_at=coalesce(consumed_at,clock_timestamp())
     where workspace_id=$1 and parent_run_id=$2 and invocation_key=any($3::varchar[])
       and status not in ('pending','accepted')`,
    [workspaceId, runId, settledKeys],
  );
  if (terminalRunStatuses.has(plan.checkpoint.runStatus)) {
    const controls = await client.query<{ child_run_id: string | null }>(
      `update app.workflow_calls set
         status=case when status='pending' then 'refused' else status end,
         safe_error_code=case when status='pending' then 'call_parent_closed' else safe_error_code end,
         completed_at=case when status='pending' then clock_timestamp() else completed_at end,
         consumed_at=coalesce(consumed_at,clock_timestamp()),
         cancel_requested_at=case when status='accepted' then coalesce(cancel_requested_at,clock_timestamp()) else cancel_requested_at end
       where workspace_id=$1 and parent_run_id=$2 and consumed_at is null
       returning child_run_id`,
      [workspaceId, runId],
    );
    for (const row of controls.rows)
      if (row.child_run_id !== null)
        await wakeWorkflowRun(client, workspaceId, row.child_run_id);
    return;
  }
  if (plan.checkpoint.invocations.some(({ status }) => status === 'running'))
    return;
  const continuation = await client.query<{ needed: boolean }>(
    `select exists(select 1 from app.workflow_calls where workspace_id=$1 and parent_run_id=$2
       and (status='pending' or (status='refused' and consumed_at is null)))
       and not exists(select 1 from app.workflow_calls where workspace_id=$1 and parent_run_id=$2 and slot_lent) as needed`,
    [workspaceId, runId],
  );
  if (continuation.rows[0]?.needed ?? false)
    await wakeWorkflowRun(client, workspaceId, runId);
}
