import { and, eq, sql } from 'drizzle-orm';
import { workflows } from '../../schema/authoring/workflows.js';
import { workflowCalls } from '../../schema/runs/calls.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  lockCallParent,
  lockPendingCall,
  type PendingWorkflowCall,
} from './admission.queries.js';
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
import { findLockedReplayVersion } from '../commands/replay.repository.js';
import type { PublishedWorkflow } from '../queries/execution/published.queries.js';
import { WorkflowCallRefusedError } from './contract.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

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
  const [target] = await transaction.db
    .select({ lifecycle_status: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.id, call.target_workflow_id),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const projection = await findLockedReplayVersion(
    transaction,
    call.target_workflow_id,
    call.target_version_id,
  ).catch(rethrowQueryFailure);
  // Resolve the shared acceptance policy before parent locking even if the
  // target is unavailable; refusal itself still serializes with parent close.
  let preparation:
    Awaited<ReturnType<typeof prepareWorkflowRunAcceptance>> | undefined;
  let unavailable =
    target?.lifecycle_status !== 'active' ||
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
  const [locked] = await lockPendingCall(client, {
    workspaceId,
    parentRunId,
    callId: call.id,
  });
  if (locked?.status !== 'pending') return;
  const lent = await transaction.db
    .select({ id: workflowCalls.id })
    .from(workflowCalls)
    .where(
      and(
        eq(workflowCalls.workspaceId, workspaceId),
        eq(workflowCalls.parentRunId, parentRunId),
        eq(workflowCalls.slotLent, true),
      ),
    )
    .catch(rethrowQueryFailure);
  if (lent.length > 0) return;
  await transaction.db
    .execute(sql`savepoint workflow_call_candidate`)
    .catch(rethrowQueryFailure);
  try {
    const { prepared, initial, stored } = prepareCallInput(input, {
      projection,
      preparation,
      unavailable,
      expired: locked.deadline_expired ?? false,
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
    const c = workflowCalls;
    const bound = await transaction.db
      .update(c)
      .set({
        status: 'accepted',
        childRunId: accepted.runId,
        liveChildRunId: accepted.runId,
      })
      .where(
        and(
          eq(c.workspaceId, workspaceId),
          eq(c.id, call.id),
          eq(c.status, 'pending'),
        ),
      )
      .catch(rethrowQueryFailure);
    if (bound.rowCount !== 1)
      throw new Error('Call acceptance identity changed under its lock');
    const transfer = await transaction.db
      .execute<{ granted: boolean }>(
        sql`select app.lend_workflow_run_slot(${workspaceId},${call.id},${accepted.runId},${accepted.outboxEventId}) granted`,
      )
      .catch(rethrowQueryFailure);
    if (!(transfer.rows[0]?.granted ?? false))
      throw new WorkflowCallRefusedError('call_target_capacity_exceeded');
    await transaction.db
      .execute(sql`release savepoint workflow_call_candidate`)
      .catch(rethrowQueryFailure);
  } catch (error) {
    const refusal = callAdmissionRefusal(error);
    if (refusal === undefined) throw error;
    await transaction.db
      .execute(sql`rollback to savepoint workflow_call_candidate`)
      .catch(rethrowQueryFailure);
    await transaction.db
      .execute(sql`release savepoint workflow_call_candidate`)
      .catch(rethrowQueryFailure);
    const c = workflowCalls;
    await transaction.db
      .update(c)
      .set({
        status: 'refused',
        safeErrorCode: refusal,
        completedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(c.workspaceId, workspaceId),
          eq(c.id, call.id),
          eq(c.status, 'pending'),
        ),
      )
      .catch(rethrowQueryFailure);
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
  const [row] = await lockCallParent(client, {
    workspaceId,
    parentRunId,
    invocationKey: call.invocation_key,
  });
  const parentUnavailable =
    row === undefined ||
    !['running', 'waiting'].includes(row.status) ||
    row.cancel_requested_at !== null ||
    (row.deadline_expired ?? false) ||
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
    projection: PublishedWorkflow | null;
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
