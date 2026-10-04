import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { CoordinatorCheckpoint as PersistedWorkflowCheckpoint } from './coordinator-checkpoint.js';
import { assertWorkflowCallResultOutput } from '../workflow-calls/workflow-call-result-reference.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from '../stored-execution-value.js';

type Invocation = PersistedWorkflowCheckpoint['invocations'][number];

function expectedPhysicalStatuses(
  invocation: Invocation,
  previous: Invocation | undefined,
  checkpoint: PersistedWorkflowCheckpoint,
  row:
    | Readonly<{ control_kind: string | null; attempt_status: string | null }>
    | undefined,
  waitResumeKeys: ReadonlySet<string>,
  stoppedForEachKeys: ReadonlySet<string>,
) {
  const isLoopControl = checkpoint.loops.some(
    ({ controlInvocationKey }) =>
      controlInvocationKey === invocation.invocationKey,
  );
  const physicalLoopStatus =
    isLoopControl && row?.control_kind === 'for_each_barrier'
      ? 'waiting'
      : 'succeeded';
  const isSuspendedNodeWait =
    invocation.status === 'waiting' && invocation.waitKind === 'node_wait';
  const isStoppedSuspendedNodeWait =
    previous?.status === 'waiting' &&
    previous.waitKind === 'node_wait' &&
    (invocation.status === 'canceled' || invocation.status === 'timed_out');
  const isWaitResume =
    invocation.status === 'running' &&
    invocation.waitKind === undefined &&
    waitResumeKeys.has(invocation.invocationKey);
  const isFreshStoppedDeclaration = stoppedForEachKeys.has(
    invocation.invocationKey,
  );
  const isRetainedStoppedDeclaration =
    checkpoint.schemaVersion === 3 &&
    previous?.status === invocation.status &&
    (invocation.status === 'canceled' || invocation.status === 'timed_out') &&
    row?.attempt_status === 'succeeded' &&
    !isLoopControl &&
    serializeStoredExecutionJsonValue(previous.output) ===
      serializeStoredExecutionJsonValue(invocation.output);
  const expectedNodeStatus = isFreshStoppedDeclaration
    ? 'succeeded'
    : isSuspendedNodeWait || isStoppedSuspendedNodeWait || isWaitResume
      ? 'waiting'
      : isLoopControl
        ? physicalLoopStatus
        : invocation.status;
  const expectedAttemptStatus =
    isSuspendedNodeWait ||
    isStoppedSuspendedNodeWait ||
    isWaitResume ||
    isFreshStoppedDeclaration ||
    isRetainedStoppedDeclaration ||
    isLoopControl
      ? 'succeeded'
      : invocation.status;

  return { expectedNodeStatus, expectedAttemptStatus };
}

export async function validateCheckpointOutputOwnership(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  currentCheckpoint: PersistedWorkflowCheckpoint,
  checkpoint: PersistedWorkflowCheckpoint,
  waitResumeKeys: ReadonlySet<string>,
  stoppedForEachKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  const expected = checkpoint.invocations.filter(
    (invocation) =>
      invocation.output !== undefined &&
      invocation.output.kind !== 'workflow_call',
  );
  for (const invocation of checkpoint.invocations) {
    if (invocation.output?.kind !== 'workflow_call') continue;
    await assertWorkflowCallResultOutput(client, {
      parentRunId: runId,
      invocationKey: invocation.invocationKey,
      childRunId: invocation.output.childRunId,
      compareLogicalNode: false,
    });
  }
  if (expected.length === 0) return;
  const rows = await client.query<{
    attempt_id: string | null;
    attempt_output_ref: unknown;
    attempt_status: string | null;
    control_kind: string | null;
    invocation_key: string;
    node_output_ref: unknown;
    node_status: string;
  }>(
    `select node.invocation_key, node.status as node_status,node.control_kind,
            node.output_ref as node_output_ref,
            attempt.id as attempt_id, attempt.status as attempt_status,
            attempt.output_ref as attempt_output_ref
     from app.node_runs node
     join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id
      and attempt.id=node.current_attempt_id
     where node.workspace_id=$1 and node.workflow_run_id=$2
       and node.invocation_key=any($3::varchar[])
     for share of node, attempt`,
    [workspaceId, runId, expected.map(({ invocationKey }) => invocationKey)],
  );
  const physical = new Map(rows.rows.map((row) => [row.invocation_key, row]));
  const currentInvocations = new Map(
    currentCheckpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const artifacts = new Set<string>();
  for (const invocation of expected) {
    const row = physical.get(invocation.invocationKey);
    const previous = currentInvocations.get(invocation.invocationKey);
    const { expectedNodeStatus, expectedAttemptStatus } =
      expectedPhysicalStatuses(
        invocation,
        previous,
        checkpoint,
        row,
        waitResumeKeys,
        stoppedForEachKeys,
      );
    if (
      row?.attempt_id === undefined ||
      row.attempt_id === null ||
      row.node_status !== expectedNodeStatus ||
      row.attempt_status !== expectedAttemptStatus
    )
      throw new CoordinatorRunStateCorruptError();
    let nodeValue;
    let attemptValue;
    try {
      nodeValue = parseStoredExecutionValueV1(row.node_output_ref);
      attemptValue = parseStoredExecutionValueV1(row.attempt_output_ref);
    } catch {
      throw new CoordinatorRunStateCorruptError();
    }
    if (
      serializeStoredExecutionJsonValue(nodeValue) !==
      serializeStoredExecutionJsonValue(attemptValue)
    )
      throw new CoordinatorRunStateCorruptError();
    const output = invocation.output;
    if (output === undefined) throw new CoordinatorRunStateCorruptError();
    if (output.kind === 'inline') {
      if (output.attemptId !== row.attempt_id || nodeValue.kind !== 'inline')
        throw new CoordinatorRunStateCorruptError();
    } else if (output.kind === 'artifact') {
      if (
        nodeValue.kind !== 'artifact' ||
        nodeValue.artifactId !== output.artifactId
      )
        throw new CoordinatorRunStateCorruptError();
      artifacts.add(output.artifactId);
    } else throw new CoordinatorRunStateCorruptError();
  }
  if (artifacts.size === 0) return;
  const available = await client.query<{ id: string }>(
    `select id from app.artifacts
     where workspace_id=$1 and id=any($2::uuid[])
       and status='available' and deleted_at is null
     for share`,
    [workspaceId, [...artifacts]],
  );
  if (available.rows.length !== artifacts.size)
    throw new CoordinatorRunStateCorruptError();
}
