import type { PoolClient } from 'pg';
import {
  workflowForEachBoundsV2,
  workflowForEachBoundsV3,
} from '@pertexo/workflow-model/graph';
import { isRejectedForEachCollection } from './coordinator-rejected-loop-collection.js';
import { assertWorkflowCallResultOutput } from '../workflow-calls/workflow-call-result-reference.js';

import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { CoordinatorCheckpoint as PersistedWorkflowCheckpoint } from './coordinator-checkpoint.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from '../stored-execution-value.js';

type Invocation = PersistedWorkflowCheckpoint['invocations'][number];

type PhysicalInvocationRow = Readonly<{
  attempt_id: string | null;
  attempt_number: number | null;
  attempt_output_ref: unknown;
  attempt_status: string | null;
  current_attempt_id: string | null;
  current_attempt_number: number | null;
  invocation_key: string;
  branch_context: unknown;
  control_kind: string | null;
  node_id: string;
  node_output_ref: unknown;
  node_input_ref: unknown;
  node_status: string;
  resume_at: Date | null;
  retry_due_at: Date | null;
  wait_kind: 'node_wait' | 'retry_backoff' | null;
  safe_error_code: string | null;
  has_rejection_fact: boolean;
}>;

function corruptIf(condition: boolean): void {
  if (condition) throw new CoordinatorRunStateCorruptError();
}

export async function assertAvailableArtifacts(
  client: PoolClient,
  workspaceId: string,
  artifactIds: ReadonlySet<string>,
): Promise<void> {
  if (artifactIds.size === 0) return;
  const available = await client.query<{ id: string }>(
    `select id from app.artifacts
     where workspace_id=$1 and id=any($2::uuid[])
       and status='available' and deleted_at is null`,
    [workspaceId, [...artifactIds]],
  );
  corruptIf(
    new Set(available.rows.map(({ id }) => id)).size !== artifactIds.size,
  );
}

function parsedPhysicalOutput(
  row: PhysicalInvocationRow,
  expected: Invocation['output'],
): string | undefined {
  if (expected === undefined) {
    corruptIf(row.node_output_ref !== null || row.attempt_output_ref !== null);
    return undefined;
  }
  corruptIf(row.attempt_id === null);
  let nodeValue;
  let attemptValue;
  try {
    nodeValue = parseStoredExecutionValueV1(row.node_output_ref);
    attemptValue = parseStoredExecutionValueV1(row.attempt_output_ref);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  corruptIf(
    serializeStoredExecutionJsonValue(nodeValue) !==
      serializeStoredExecutionJsonValue(attemptValue),
  );
  if (expected.kind === 'inline') {
    corruptIf(
      nodeValue.kind !== 'inline' || expected.attemptId !== row.attempt_id,
    );
    return undefined;
  }
  if (expected.kind !== 'artifact') throw new CoordinatorRunStateCorruptError();
  corruptIf(
    nodeValue.kind !== 'artifact' ||
      nodeValue.artifactId !== expected.artifactId,
  );
  return expected.artifactId;
}

function expectedBranchContext(
  invocation: Invocation,
): Readonly<Record<string, unknown>> {
  return {
    ...('branchPath' in invocation && invocation.branchPath !== undefined
      ? { branchPath: invocation.branchPath }
      : {}),
    ...('iterationPath' in invocation && invocation.iterationPath !== undefined
      ? { iterationPath: invocation.iterationPath }
      : {}),
  };
}

function validateAttemptIdentity(
  row: PhysicalInvocationRow,
  invocation: Invocation,
): void {
  if (invocation.attemptNumber === 0) {
    corruptIf(
      row.current_attempt_id !== null ||
        row.current_attempt_number !== null ||
        row.attempt_id !== null ||
        row.attempt_number !== null ||
        row.attempt_status !== null,
    );
    return;
  }
  corruptIf(
    row.current_attempt_id === null ||
      row.current_attempt_id !== row.attempt_id ||
      row.current_attempt_number !== invocation.attemptNumber ||
      row.attempt_number !== invocation.attemptNumber ||
      row.attempt_status === null,
  );
}

function validateRunning(
  row: PhysicalInvocationRow,
  invocation: Invocation,
  freshFact: Readonly<Record<string, unknown>> | undefined,
): void {
  const physicalInFlight =
    (row.node_status === 'ready' && row.attempt_status === 'ready') ||
    (row.node_status === 'running' && row.attempt_status === 'running');
  const physicalAheadWithFact =
    freshFact?.attemptNumber === invocation.attemptNumber &&
    (freshFact.kind === 'wait' ||
      freshFact.kind === 'outcome' ||
      (freshFact.kind === 'attempt_failure' &&
        row.node_status === 'running' &&
        row.attempt_status === 'failed'));
  corruptIf(!physicalInFlight && !physicalAheadWithFact);
}

function validateWaiting(
  row: PhysicalInvocationRow,
  invocation: Invocation,
  checkpoint: PersistedWorkflowCheckpoint,
): void {
  const dueAt = row.retry_due_at ?? row.resume_at;
  const isLoopBarrier = checkpoint.loops.some(
    ({ controlInvocationKey }) =>
      controlInvocationKey === invocation.invocationKey,
  );
  const isCall =
    checkpoint.schemaVersion === 3 &&
    checkpoint.calls.some(
      ({ invocationKey }) => invocationKey === invocation.invocationKey,
    );
  corruptIf(row.node_status !== 'waiting');
  corruptIf(
    isLoopBarrier || isCall
      ? row.control_kind !== (isCall ? 'workflow_call' : 'for_each_barrier')
      : row.control_kind !== null,
  );
  corruptIf(
    row.attempt_status !== 'succeeded' && row.attempt_status !== 'failed',
  );
  corruptIf(
    isLoopBarrier || isCall
      ? invocation.resumeAt !== undefined || dueAt !== null
      : invocation.resumeAt === undefined ||
          dueAt?.toISOString() !== invocation.resumeAt,
  );
  corruptIf(!isLoopBarrier && !isCall && row.wait_kind !== invocation.waitKind);
}

function validateReady(
  row: PhysicalInvocationRow,
  invocation: Invocation,
): void {
  corruptIf(row.node_status !== 'ready');
  corruptIf(row.resume_at !== null || row.retry_due_at !== null);
  corruptIf(
    invocation.attemptNumber > 0 &&
      row.attempt_status !== 'succeeded' &&
      row.attempt_status !== 'failed',
  );
}

function validatePhysicalStatus(
  row: PhysicalInvocationRow,
  invocation: Invocation,
  checkpoint: PersistedWorkflowCheckpoint,
  freshFact: Readonly<Record<string, unknown>> | undefined,
): void {
  switch (invocation.status) {
    case 'running':
      validateRunning(row, invocation, freshFact);
      return;
    case 'waiting':
      validateWaiting(row, invocation, checkpoint);
      return;
    case 'ready':
      validateReady(row, invocation);
      return;
    case 'pending':
      corruptIf(
        row.node_status !== 'pending' || invocation.attemptNumber !== 0,
      );
      return;
    default:
      corruptIf(row.node_status !== invocation.status);
  }
}

function validateInvocation(
  row: PhysicalInvocationRow | undefined,
  invocation: Invocation,
  checkpoint: PersistedWorkflowCheckpoint,
  freshFact: Readonly<Record<string, unknown>> | undefined,
  executableJson: unknown,
): string | undefined {
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  corruptIf(row.node_id !== invocation.nodeId);
  corruptIf(
    serializeStoredExecutionJsonValue(row.branch_context) !==
      serializeStoredExecutionJsonValue(expectedBranchContext(invocation)),
  );
  validateAttemptIdentity(row, invocation);
  validatePhysicalStatus(row, invocation, checkpoint, freshFact);
  if (
    checkpoint.schemaVersion === 3 &&
    checkpoint.calls.some(
      ({ invocationKey }) => invocationKey === invocation.invocationKey,
    )
  ) {
    corruptIf(
      row.attempt_status !== 'succeeded' ||
        row.current_attempt_number !== 1 ||
        row.node_input_ref === null,
    );
    corruptIf(
      serializeStoredExecutionJsonValue(row.node_input_ref) !==
        serializeStoredExecutionJsonValue(row.attempt_output_ref),
    );
    if (invocation.output === undefined)
      corruptIf(row.node_output_ref !== null);
    return undefined;
  }
  if (invocation.status === 'failed' && row.attempt_status === 'succeeded') {
    validateRejectedForEachState(row, invocation, checkpoint, executableJson);
    return undefined;
  }
  return invocation.status === 'running' && freshFact !== undefined
    ? undefined
    : parsedPhysicalOutput(row, invocation.output);
}

function validateRejectedForEachState(
  row: PhysicalInvocationRow,
  invocation: Invocation,
  checkpoint: PersistedWorkflowCheckpoint,
  executableJson: unknown,
): void {
  corruptIf(
    row.safe_error_code !== 'loop_limit_exceeded' ||
      !row.has_rejection_fact ||
      row.node_output_ref !== null ||
      invocation.output !== undefined ||
      row.control_kind !== null ||
      row.wait_kind !== null ||
      row.resume_at !== null ||
      row.retry_due_at !== null ||
      checkpoint.loops.some(
        (loop) => loop.controlInvocationKey === invocation.invocationKey,
      ),
  );
  try {
    const stored = parseStoredExecutionValueV1(row.attempt_output_ref);
    corruptIf(stored.kind !== 'inline');
    if (stored.kind !== 'inline') return;
    const iterationPath =
      'iterationPath' in invocation ? (invocation.iterationPath ?? []) : [];
    corruptIf(
      iterationPath.some(
        (scope, index) =>
          checkpoint.loops.filter(
            (loop) =>
              loop.loopId === scope.loopNodeId &&
              serializeStoredExecutionJsonValue(loop.iterationPath) ===
                serializeStoredExecutionJsonValue(
                  iterationPath.slice(0, index),
                ) &&
              loop.branchPath.every(
                (branch, ordinal) =>
                  serializeStoredExecutionJsonValue(branch) ===
                  serializeStoredExecutionJsonValue(
                    'branchPath' in invocation
                      ? invocation.branchPath?.[ordinal]
                      : undefined,
                  ),
              ) &&
              (loop.activeOrdinals.includes(scope.ordinal) ||
                loop.terminalOrdinals.includes(scope.ordinal)),
          ).length !== 1,
      ),
    );
    corruptIf(
      !isRejectedForEachCollection({
        nodeId: invocation.nodeId,
        iterationPath,
        value: stored.value,
        bounds: (checkpoint.schemaVersion === 3
          ? workflowForEachBoundsV3
          : workflowForEachBoundsV2)(executableJson),
        remainingIterationBudget: checkpoint.remainingIterationBudget,
      }),
    );
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}

export async function validateLoadedCheckpointPhysicalState(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  checkpoint: PersistedWorkflowCheckpoint,
  freshSemanticFacts: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  executableJson?: unknown,
): Promise<void> {
  const result = await client.query<PhysicalInvocationRow>(
    `select node.invocation_key, node.node_id, node.branch_context,
             node.control_kind,node.safe_error_code,
             case when node.status='failed' and node.safe_error_code='loop_limit_exceeded'
                       and attempt.status='succeeded' then exists(select 1 from app.run_events event
               where event.workspace_id=node.workspace_id
                 and event.workflow_run_id=node.workflow_run_id
                 and event.type='node.failed'
                 and event.payload->>'reasonCode'='loop_limit_exceeded'
                 and event.payload->>'invocationKey'=node.invocation_key
                 and event.payload->>'attemptId'=node.current_attempt_id::text
                 and event.payload->>'nodeRunId'=node.id::text
                 and event.payload->>'nodeId'=node.node_id
                 and event.payload->>'attemptNumber'=node.current_attempt_number::text
             ) else false end as has_rejection_fact,
            node.status as node_status,
            node.current_attempt_id, node.current_attempt_number,
             node.resume_at, node.retry_due_at, node.wait_kind,
            node.output_ref as node_output_ref,node.input_ref as node_input_ref,
            attempt.id as attempt_id, attempt.attempt_number,
            attempt.status as attempt_status,
            attempt.output_ref as attempt_output_ref
     from app.node_runs node
     left join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id
      and attempt.id=node.current_attempt_id
     where node.workspace_id=$1 and node.workflow_run_id=$2`,
    [workspaceId, runId],
  );
  const rows = new Map(
    result.rows.map((row) => [row.invocation_key, row] as const),
  );
  corruptIf(
    rows.size !== result.rows.length ||
      rows.size !== checkpoint.invocations.length,
  );

  const artifactIds = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    const artifactId = validateInvocation(
      rows.get(invocation.invocationKey),
      invocation,
      checkpoint,
      freshSemanticFacts.get(invocation.invocationKey),
      executableJson,
    );
    if (artifactId !== undefined) artifactIds.add(artifactId);
    if (invocation.output?.kind === 'workflow_call') {
      await assertWorkflowCallResultOutput(client, {
        parentRunId: runId,
        invocationKey: invocation.invocationKey,
        childRunId: invocation.output.childRunId,
        compareLogicalNode: true,
      });
    }
  }
  await assertAvailableArtifacts(client, workspaceId, artifactIds);
}
