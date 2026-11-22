import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { IDEMPOTENCY_STATUS } from '@pertexo/database/primitives';
import {
  idempotencyRecords,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '@pertexo/database/schema';
import { RUN_STATUS } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';

import { MILLISECOND_INTERVAL } from '../../../shared/sql-intervals.repository.js';
import { runInputRetentionSql } from '../../../shared/run-records/run-retention.repository.js';
import { QUEUED_EVENT_SEQUENCE } from '../../../shared/run-records/run-events.repository.js';
import type {
  AcceptWorkflowRunInput,
  PreparedWorkflowRunAcceptance,
} from './run-acceptance.types.js';

type ParsedRunInput = AcceptWorkflowRunInput;
export type RunAdmissionState = Readonly<{
  prepared: PreparedWorkflowRunAcceptance;
  runId: string;
  storedRunInputJson: string | null;
  variableSetRevision: number | null;
  sourceOrigin: boolean;
}>;

/** Whether the replayed source run came from an error workflow. */
export async function readErrorWorkflowOrigin(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
): Promise<boolean> {
  const [source] = await transaction.db
    .select({ origin: workflowRuns.errorWorkflowOrigin })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, sourceRunId),
      ),
    )
    .limit(1);
  return source?.origin ?? false;
}

/** Claims the acceptance key; false when another acceptance already holds it. */
export async function claimAcceptance(
  transaction: WorkspaceTransaction,
  input: ParsedRunInput,
  claim: Readonly<{ id: string; runId: string }>,
): Promise<boolean> {
  const inserted = await transaction.db
    .insert(idempotencyRecords)
    .values({
      id: claim.id,
      workspaceId: transaction.workspaceId,
      operation: input.operation,
      scope: input.scope,
      keyHash: input.keyHash,
      requestHash: input.requestHash,
      status: IDEMPOTENCY_STATUS.inProgress,
      resourceId: claim.runId,
      resultRef: {},
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.workspaceId,
        idempotencyRecords.operation,
        idempotencyRecords.scope,
        idempotencyRecords.keyHash,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  return inserted.length !== 0;
}

/** Completes the claim with its result; false when it was no longer in progress. */
export async function completeAcceptance(
  transaction: WorkspaceTransaction,
  claimId: string,
  resultRef: Readonly<{ outboxEventId: string; initialCheckpointHash: string }>,
): Promise<boolean> {
  const completed = await transaction.db
    .update(idempotencyRecords)
    .set({
      resultRef,
      status: IDEMPOTENCY_STATUS.completed,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(idempotencyRecords.id, claimId),
        eq(idempotencyRecords.status, IDEMPOTENCY_STATUS.inProgress),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  return completed.length === 1;
}

/** Inserts the queued run; its acceptance time, or undefined when nothing was written. */
export async function insertAcceptedRun(
  transaction: WorkspaceTransaction,
  parsed: ParsedRunInput,
  state: RunAdmissionState,
): Promise<Readonly<{ acceptedAt: Date }> | undefined> {
  const [inserted] = await transaction.db
    .insert(workflowRuns)
    .values(acceptedWorkflowRunValues(transaction, parsed, state))
    .returning({ acceptedAt: workflowRuns.createdAt });
  return inserted;
}

function acceptedWorkflowRunValues(
  transaction: WorkspaceTransaction,
  parsed: ParsedRunInput,
  {
    prepared,
    runId,
    storedRunInputJson,
    variableSetRevision,
    sourceOrigin,
  }: RunAdmissionState,
) {
  const { failureNotificationPolicy } = prepared;
  return {
    id: runId,
    ...(parsed.mcpInvocation === undefined
      ? {}
      : { mcpInvocation: parsed.mcpInvocation(runId) }),
    workspaceId: transaction.workspaceId,
    workflowId: parsed.workflowId,
    workflowVersionId: parsed.workflowVersionId,
    ...(prepared.recovery === undefined
      ? {}
      : {
          recoveryTargetNodeRunId: prepared.recovery.targetNodeRunId,
          recoveryTargetNodeId: prepared.recovery.targetNodeId,
          recoveryReusedCount: prepared.recovery.reusedCount,
          recoveryEffectRisk: prepared.recovery.effectRisk,
          recoveryEffectsAcknowledged: prepared.recovery.effectsAcknowledged,
        }),
    ...(parsed.replayCommandId === undefined
      ? {}
      : {
          replayCommandId: parsed.replayCommandId,
          replaySourceRunId: parsed.replaySourceRunId,
        }),
    inputRef:
      storedRunInputJson === null ? null : sql`${storedRunInputJson}::json`,
    inputRefExpiresAt:
      storedRunInputJson === null
        ? null
        : sql`now() + ${runInputRetentionSql(parsed.triggerType)}`,
    variableSetRevision,
    triggerType: parsed.triggerType,
    startedBy: parsed.startedBy ?? null,
    absoluteDeadlineAt:
      parsed.absoluteDeadlineAt === undefined
        ? (parsed.deadlineAt ?? null)
        : parsed.absoluteDeadlineAt,
    errorWorkflowOrigin:
      parsed.triggerType === 'workflow_error' ||
      (prepared.errorWorkflowOrigin ?? false) ||
      sourceOrigin,
    ...(failureNotificationPolicy === undefined
      ? {}
      : {
          failureNotificationDestinationId:
            failureNotificationPolicy.destinationId,
          failureNotificationDestinationConfigVersion:
            failureNotificationPolicy.destinationConfigVersion,
          failureNotificationSideEffectClass:
            failureNotificationPolicy.sideEffectClass,
          failureNotificationConnectionSecretVersionId:
            failureNotificationPolicy.connectionSecretVersionId,
        }),
    // Match created_at's PostgreSQL transaction clock, so queueing and
    // durable waits consume the published run budget too. LEAST ignores
    // null operands: an absent limit preserves the caller's deadline,
    // while a later caller deadline cannot extend the version's limit.
    deadlineAt: sql`least(
          ${parsed.deadlineAt?.toISOString() ?? null}::timestamptz,
          (select now() +
             (version.executable_json #>> '{graph,settings,maxRunDurationMs}')::integer
               * ${MILLISECOND_INTERVAL}
           from app.workflow_versions version
           where version.workspace_id = ${transaction.workspaceId}
             and version.workflow_id = ${parsed.workflowId}
             and version.id = ${parsed.workflowVersionId})
        )`,
    status: RUN_STATUS.queued,
  };
}

/** The run's first event and its initial checkpoint. */
export async function insertRunStart(
  transaction: WorkspaceTransaction,
  parsed: ParsedRunInput,
  {
    runId,
    initialCheckpointJson,
  }: Readonly<{ runId: string; initialCheckpointJson: string }>,
): Promise<void> {
  await transaction.db.insert(runEvents).values({
    workspaceId: transaction.workspaceId,
    workflowRunId: runId,
    sequence: QUEUED_EVENT_SEQUENCE,
    type: 'run.queued',
    payload: {},
  });
  await transaction.db.insert(runCheckpoints).values({
    workflowRunId: runId,
    workspaceId: transaction.workspaceId,
    workflowVersionId: parsed.workflowVersionId,
    revision: 0,
    schedulerState: sql`${initialCheckpointJson}::jsonb`,
  });
}
