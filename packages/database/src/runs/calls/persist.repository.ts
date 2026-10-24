import { utf8ByteLength } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkflowCallIntent } from '@pertexo/workflow-engine';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  prepareStoredExecutionValue,
  STORED_EXECUTION_VALUE_LIMITS,
} from '../../platform/stored-execution-value.js';
import { CoordinatorRunStateCorruptError } from '../advance/contract.js';
import {
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../advance/plan.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

async function preparedInput(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  intent: WorkflowCallIntent,
): Promise<
  Readonly<{ json: string | null; checksum: string; refusal?: string }>
> {
  const result = await client.query<{ id: string; output_ref: unknown }>(
    `select attempt.id,attempt.output_ref
     from app.node_runs node join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id
       and attempt.id=node.current_attempt_id and attempt.attempt_number=node.current_attempt_number
     where node.workspace_id=$1 and node.workflow_run_id=$2 and node.invocation_key=$3
       and node.status='succeeded' and attempt.status='succeeded'
       and node.output_ref::jsonb=attempt.output_ref::jsonb`,
    [workspaceId, runId, intent.invocationKey],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  const prepared = prepareStoredExecutionValue(row.output_ref);
  const inputMismatch =
    (intent.input.kind === 'inline' &&
      (intent.input.attemptId !== row.id ||
        prepared.value.kind !== 'inline')) ||
    (intent.input.kind === 'artifact' &&
      (prepared.value.kind !== 'artifact' ||
        intent.input.artifactId !== prepared.value.artifactId));
  if (inputMismatch) throw new CoordinatorRunStateCorruptError();
  const checksum = createHash('sha256').update(prepared.json).digest('hex');
  const refusal = callInputRefusal(prepared);
  return {
    json: refusal === undefined ? prepared.json : null,
    checksum,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/** Intent, wait and wakeup are saved in the parent's checkpoint transaction. */
export async function persistCallIntents(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  const { workspaceId, runId, plan } = input;
  const closed = terminalRunStatuses.has(plan.checkpoint.runStatus);
  for (const intent of plan.callIntents ?? []) {
    const prepared = await preparedInput(client, workspaceId, runId, intent);
    const refusal = closed ? 'call_parent_closed' : prepared.refusal;
    const result = await client.query<{ id: string }>(
      `insert into app.workflow_calls
       (id,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,
        target_checksum,input_ref,input_checksum,deadline_at,status,safe_error_code,completed_at)
       select $1,$2,$3,$4,$5,$6,$7::varchar,$8::json,$9,
         least(run.deadline_at,clock_timestamp() +
           (version.executable_json #>> '{graph,settings,maxRunDurationMs}')::integer * interval '1 millisecond'),
         $10,$11,case when $11::varchar is null then null else clock_timestamp() end
       from app.workflow_runs run join app.workflow_versions version
         on version.workspace_id=run.workspace_id and version.workflow_id=$5 and version.id=$6
       where run.workspace_id=$2 and run.id=$3 and version.checksum=$7::varchar
       on conflict(workspace_id,parent_run_id,invocation_key) do nothing
       returning id`,
      [
        generatePersistedId(),
        workspaceId,
        runId,
        intent.invocationKey,
        intent.target.workflowId,
        intent.target.workflowVersionId,
        intent.target.executableChecksum,
        prepared.json,
        prepared.checksum,
        refusal === undefined ? 'pending' : 'refused',
        refusal ?? null,
      ],
    );
    if (result.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
    // A declaration may settle in the same transition as parent cancellation.
    // The ordinary event writer still requires a waiting logical node first.
    const wait = await client.query(
      `update app.node_runs set status='waiting',control_kind='workflow_call',output_ref=null,
         completed_at=null,resume_at=null,retry_due_at=null,due_wakeup_at=null,wait_kind=null,
         updated_at=clock_timestamp()
       where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3 and status='succeeded'`,
      [workspaceId, runId, intent.invocationKey],
    );
    if (wait.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}

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

function callInputRefusal(
  prepared: ReturnType<typeof prepareStoredExecutionValue>,
): string | undefined {
  if (prepared.value.kind === 'artifact') {
    return 'call_input_artifact_unsupported';
  }
  if (
    utf8ByteLength(prepared.json) > STORED_EXECUTION_VALUE_LIMITS.inlineBytes
  ) {
    return 'call_input_too_large';
  }
  return undefined;
}
