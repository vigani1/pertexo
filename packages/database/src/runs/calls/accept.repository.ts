import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  CallableInputInvalidError,
  canonicalJson,
} from '@pertexo/workflow-model';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../commands/acceptance.repository.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import { parsePublishedWorkflowRow } from '../queries/execution/published.queries.js';
import { WorkflowCallRefusedError } from './contract.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

export type PendingWorkflowCall = Readonly<{
  id: string;
  invocation_key: string;
  target_workflow_id: string;
  target_version_id: string;
  target_checksum: string;
  input_ref: unknown;
  input_checksum: string;
  deadline_at: Date | null;
}>;

/** All target prerequisites precede the parent and the counter stays last. */
export async function acceptPendingCall(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    parentRunId: string;
    call: PendingWorkflowCall;
    prepareChild: InitialCheckpointFactory;
    traceparent?: string;
  }>,
): Promise<void> {
  const { workspaceId, parentRunId, call } = input;
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(workspaceId),
  };
  const target = await client.query<{ lifecycle_status: string }>(
    'select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for share',
    [workspaceId, call.target_workflow_id],
  );
  const version = await client.query(
    'select * from app.lock_workflow_run_replay_version($1,$2,$3)',
    [workspaceId, call.target_workflow_id, call.target_version_id],
  );
  const projection = parsePublishedWorkflowRow(version.rows[0]);
  // Resolve the shared acceptance policy before parent locking even if the
  // target is unavailable; refusal itself still serializes with parent close.
  let preparation:
    Awaited<ReturnType<typeof prepareWorkflowRunAcceptance>> | undefined;
  let unavailable =
    target.rows[0]?.lifecycle_status !== 'active' ||
    projection?.checksum !== call.target_checksum;
  try {
    preparation = await prepareWorkflowRunAcceptance(
      transaction,
      call.target_workflow_id,
    );
  } catch (error) {
    if (!(error instanceof WorkspaceRunAdmissionDeniedError)) throw error;
    unavailable = true;
  }
  const row = await lockWaitingCallParent(client, input);
  if (row === undefined) return;
  const locked = await client.query<
    PendingWorkflowCall & { status: string; deadline_expired: boolean }
  >(
    'select *,deadline_at <= clock_timestamp() as deadline_expired from app.workflow_calls where workspace_id=$1 and id=$2 and parent_run_id=$3 for no key update',
    [workspaceId, call.id, parentRunId],
  );
  if (locked.rows[0]?.status !== 'pending') return;
  const lent = await client.query(
    'select id from app.workflow_calls where workspace_id=$1 and parent_run_id=$2 and slot_lent',
    [workspaceId, parentRunId],
  );
  if (lent.rows.length > 0) return;
  await client.query('savepoint workflow_call_candidate');
  try {
    const { prepared, initial, stored } = prepareCallInput(input, {
      projection,
      preparation,
      unavailable,
      expired: locked.rows[0].deadline_expired,
    });
    const accepted = await acceptWorkflowRun(
      transaction,
      callRunInput(input, { row, initial, stored }),
      {
        ...prepared,
        errorWorkflowOrigin: row.error_workflow_origin,
        variableSetRevision: row.variable_set_revision,
      },
    );
    const bound = await client.query(
      "update app.workflow_calls set status='accepted',child_run_id=$3,live_child_run_id=$3 where workspace_id=$1 and id=$2 and status='pending'",
      [workspaceId, call.id, accepted.runId],
    );
    if (bound.rowCount !== 1)
      throw new Error('Call acceptance identity changed under its lock');
    const transfer = await client.query<{ granted: boolean }>(
      'select app.lend_workflow_run_slot($1,$2,$3,$4) granted',
      [workspaceId, call.id, accepted.runId, accepted.outboxEventId],
    );
    if (!(transfer.rows[0]?.granted ?? false))
      throw new WorkflowCallRefusedError('call_target_capacity_exceeded');
    await client.query('release savepoint workflow_call_candidate');
  } catch (error) {
    const refusal = callAdmissionRefusal(error);
    if (refusal === undefined) throw error;
    await client.query('rollback to savepoint workflow_call_candidate');
    await client.query('release savepoint workflow_call_candidate');
    await client.query(
      "update app.workflow_calls set status='refused',safe_error_code=$3,completed_at=clock_timestamp() where workspace_id=$1 and id=$2 and status='pending'",
      [workspaceId, call.id, refusal],
    );
    await wakeWorkflowRun(client, workspaceId, parentRunId, input.traceparent);
  }
}

function callAdmissionRefusal(error: unknown): string | undefined {
  if (error instanceof WorkflowCallRefusedError) {
    return error.code;
  }
  if (error instanceof CallableInputInvalidError) {
    return 'call_input_invalid';
  }
  if (error instanceof WorkspaceRunQuotaExceededError) {
    return 'call_target_capacity_exceeded';
  }
  if (error instanceof WorkspaceRunAdmissionDeniedError) {
    return 'call_target_unavailable';
  }
  return undefined;
}

async function lockWaitingCallParent(
  client: PoolClient,
  input: Parameters<typeof acceptPendingCall>[1],
) {
  const { workspaceId, parentRunId, call } = input;
  const parent = await client.query<{
    status: string;
    cancel_requested_at: Date | null;
    deadline_expired: boolean;
    has_ordinary_work: boolean;
    has_wait: boolean;
    error_workflow_origin: boolean;
    started_by: string | null;
    absolute_deadline_at: Date | null;
    variable_set_revision: number | null;
  }>(
    `select run.status,run.cancel_requested_at,run.error_workflow_origin,run.started_by,run.absolute_deadline_at,run.variable_set_revision,
       run.deadline_at <= clock_timestamp() as deadline_expired,
       exists(select 1 from jsonb_array_elements(checkpoint.scheduler_state->'invocations') invocation
         where invocation->>'status'='running') as has_ordinary_work,
       exists(select 1 from jsonb_array_elements(checkpoint.scheduler_state->'invocations') invocation
         where invocation->>'invocationKey'=$3 and invocation->>'status'='waiting'
           and invocation->>'waitKind'='workflow_call') as has_wait
     from app.workflow_runs run join app.run_checkpoints checkpoint
       on checkpoint.workspace_id=run.workspace_id and checkpoint.workflow_run_id=run.id
     where run.workspace_id=$1 and run.id=$2 for no key update of run`,
    [workspaceId, parentRunId, call.invocation_key],
  );
  const row = parent.rows[0];
  const parentUnavailable =
    row === undefined ||
    !['running', 'waiting'].includes(row.status) ||
    row.cancel_requested_at !== null ||
    row.deadline_expired ||
    !row.has_wait ||
    row.has_ordinary_work;
  if (parentUnavailable) return;

  return row;
}

function callRunInput(
  input: Parameters<typeof acceptPendingCall>[1],
  {
    row,
    initial,
    stored,
  }: Readonly<{
    row: NonNullable<Awaited<ReturnType<typeof lockWaitingCallParent>>>;
    initial: ReturnType<InitialCheckpointFactory>;
    stored: Extract<
      ReturnType<typeof parseStoredExecutionValue>,
      { kind: 'inline' }
    >;
  }>,
): Parameters<typeof acceptWorkflowRun>[1] {
  const { call, parentRunId } = input;
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  return {
    initialCheckpoint: initial.checkpoint,
    ...(initial.validateInput === undefined
      ? {}
      : { validateInput: initial.validateInput }),
    operation: 'workflow.run.accept',
    scope: `workflow-call:${call.id}`,
    keyHash: digest(call.id),
    requestHash: digest(
      canonicalJson({
        callId: call.id,
        parentRunId,
        invocationKey: call.invocation_key,
        targetVersionId: call.target_version_id,
        targetChecksum: call.target_checksum,
        inputChecksum: call.input_checksum,
      }),
    ),
    runInput: stored.value,
    triggerType: 'workflow_call',
    absoluteDeadlineAt: row.absolute_deadline_at,
    ...(row.started_by === null ? {} : { startedBy: row.started_by }),
    workflowId: call.target_workflow_id,
    workflowVersionId: call.target_version_id,
    ...(call.deadline_at === null ? {} : { deadlineAt: call.deadline_at }),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
}

function prepareCallInput(
  input: Parameters<typeof acceptPendingCall>[1],
  {
    projection,
    preparation,
    unavailable,
    expired,
  }: Readonly<{
    projection: ReturnType<typeof parsePublishedWorkflowRow>;
    preparation:
      Awaited<ReturnType<typeof prepareWorkflowRunAcceptance>> | undefined;
    unavailable: boolean;
    expired: boolean;
  }>,
) {
  const { call, prepareChild } = input;
  const prepared = preparation;
  const childUnavailable =
    unavailable || projection === null || prepared === undefined;
  if (childUnavailable)
    throw new WorkflowCallRefusedError('call_target_unavailable');
  if (expired) throw new WorkflowCallRefusedError('call_deadline_expired');
  const initial = prepareChild(projection);
  const stored = parseStoredExecutionValue(call.input_ref);
  if (stored.kind !== 'inline')
    throw new WorkflowCallRefusedError('call_input_invalid');

  return { prepared, initial, stored };
}
