import { decodeStoredValue } from '../../shared/stored-values.js';
import { parseStoredExecutionValue } from '../../shared/stored-execution.js';
import {
  bindAcceptedCall,
  callAcceptanceTransaction,
  discardCallCandidate,
  keepCallCandidate,
  lendCallSlot,
  lockCallParent,
  lockCallTarget,
  lockPendingCall,
  readCallParentPublisher,
  openCallCandidate,
  parentSlotLent,
  refusePendingCall,
  type PendingWorkflowCall,
} from './admission.repository.js';
import { createHash } from 'node:crypto';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { withWorkspaceAccess } from '../../shared/access/workspace-access.js';
import type { Pool, PoolClient } from 'pg';
import { isAgentWorkInvocationKey } from '@pertexo/workflow-engine/server';
import { countReadableWorkflows } from '../../shared/resources/workflow-call-bindings.repository.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../commands/acceptance/accept.js';
import { WorkspaceRunAdmissionDeniedError } from '../commands/acceptance/run-admission.errors.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.types.js';
import { findLockedReplayVersion } from '../commands/execution-sources.repository.js';
import type { PublishedWorkflow } from '../queries/execution/workflow-execution.types.js';
import { WorkflowCallRefusedError } from './workflow-call.errors.js';
import { callAdmissionRefusal, callParentWaiting } from './acceptance.js';
import { wakeWorkflowRun } from '../../outbox/run-advance.repository.js';

/** All target prerequisites precede the parent and the counter stays last. */
export async function acceptPendingCall(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    parentRunId: string;
    call: PendingWorkflowCall;
    prepareChild: InitialCheckpointFactory;
    accessPool?: Pool;
    signal?: AbortSignal;
    traceparent?: string;
  }>,
): Promise<void> {
  const { workspaceId, parentRunId, call } = input;
  const transaction = callAcceptanceTransaction(client, workspaceId);
  const target = await lockCallTarget(client, {
    workspaceId,
    workflowId: call.target_workflow_id,
  });
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
  if (!unavailable && isAgentWorkInvocationKey(call.invocation_key))
    unavailable =
      target?.published_version_id == null ||
      !(await canDispatchAgentCall(client, input));
  const row = await lockWaitingCallParent(client, input);
  if (row === undefined) return;
  const [locked] = await lockPendingCall(client, {
    workspaceId,
    parentRunId,
    callId: call.id,
  });
  if (locked?.status !== 'pending') return;
  if (await parentSlotLent(client, { workspaceId, parentRunId })) return;
  await openCallCandidate(client);
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
    const bound = await bindAcceptedCall(client, {
      workspaceId,
      callId: call.id,
      childRunId: accepted.runId,
    });
    if (!bound)
      throw new Error('Call acceptance identity changed under its lock');
    const granted = await lendCallSlot(client, {
      workspaceId,
      callId: call.id,
      childRunId: accepted.runId,
      outboxEventId: accepted.outboxEventId,
    });
    if (!granted)
      throw new WorkflowCallRefusedError('call_target_capacity_exceeded');
    await keepCallCandidate(client);
  } catch (error) {
    const refusal = callAdmissionRefusal(error);
    if (refusal === undefined) throw error;
    await discardCallCandidate(client);
    await refusePendingCall(client, { workspaceId, callId: call.id, refusal });
    await wakeWorkflowRun(client, workspaceId, parentRunId, input.traceparent);
  }
}

async function canDispatchAgentCall(
  client: PoolClient,
  {
    accessPool,
    workspaceId,
    parentRunId,
    call,
    signal,
  }: Parameters<typeof acceptPendingCall>[1],
) {
  const publisher = await readCallParentPublisher(
    client,
    workspaceId,
    parentRunId,
  );
  if (accessPool === undefined || publisher === undefined) return false;
  const actor = { workspaceId, actorId: publisher.actorId, signal };
  return withWorkspaceAccess(
    accessPool,
    actor,
    { mode: 'visible', statuses: ACTIVE_WORKSPACE_STATUSES },
    async (read, role) =>
      role !== null &&
      (await countReadableWorkflows(
        read,
        actor,
        [call.target_workflow_id],
        role,
      )) === 1,
  );
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
  if (row === undefined || !callParentWaiting(row)) return;

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
  const callAcceptanceFingerprint = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  return {
    initialCheckpoint: initial.checkpoint,
    ...(initial.validateInput === undefined
      ? {}
      : { validateInput: initial.validateInput }),
    operation: 'workflow.run.accept',
    scope: `workflow-call:${call.id}`,
    keyHash: callAcceptanceFingerprint(call.id),
    requestHash: callAcceptanceFingerprint(
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
  const stored = decodeStoredValue(() =>
    parseStoredExecutionValue(call.input_ref),
  );
  if (stored.kind !== 'inline')
    throw new WorkflowCallRefusedError('call_input_invalid');

  return { prepared, initial, stored };
}
