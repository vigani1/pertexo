import { and, eq, sql } from 'drizzle-orm';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../transport/outbox.js';
import {
  idempotencyRecords,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../../schema.js';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import type { resolveWorkflowFailureNotificationPolicy } from '../notifications/failure-notification-policy.js';
import {
  IDEMPOTENCY_STATUS,
  RUN_STATUS,
  IdempotencyRecordCorruptError,
  throwWorkflowRunAdmissionError,
  type AcceptedWorkflowRun,
  type ParsedAcceptWorkflowRunInput,
} from './execution-acceptance-contract.js';

type AcceptancePersistence = Readonly<{
  idempotencyRecordId: string;
  runId: string;
  outboxEventId: string;
  initialCheckpointJson: string;
  initialCheckpointHash: string;
  storedRunInputJson: string | null;
  failureNotificationPolicy: Awaited<
    ReturnType<typeof resolveWorkflowFailureNotificationPolicy>
  >;
}>;

/** Persist a won acceptance claim on the caller's existing workspace transaction. */
export async function persistWorkflowRunAcceptance(
  transaction: WorkspaceTransaction,
  parsed: ParsedAcceptWorkflowRunInput,
  prepared: AcceptancePersistence,
): Promise<AcceptedWorkflowRun> {
  const {
    idempotencyRecordId,
    runId,
    outboxEventId,
    initialCheckpointJson,
    initialCheckpointHash,
    storedRunInputJson,
    failureNotificationPolicy,
  } = prepared;
  const resultRef = { outboxEventId, initialCheckpointHash } as const;
  let insertedRuns;
  try {
    insertedRuns = await transaction.db
      .insert(workflowRuns)
      .values({
        id: runId,
        workspaceId: transaction.workspaceId,
        workflowId: parsed.workflowId,
        workflowVersionId: parsed.workflowVersionId,
        ...(parsed.replayCommandId === undefined
          ? {}
          : {
              replayCommandId: parsed.replayCommandId,
              replaySourceRunId: parsed.replaySourceRunId,
            }),
        inputRef:
          storedRunInputJson === null
            ? null
            : sql`${storedRunInputJson}::jsonb`,
        inputRefExpiresAt:
          storedRunInputJson === null ? null : sql`now() + interval '30 days'`,
        triggerType: parsed.triggerType,
        ...(failureNotificationPolicy === undefined
          ? {}
          : {
              failureNotificationPolicyVersion:
                failureNotificationPolicy.policyVersion,
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
               * interval '1 millisecond'
           from app.workflow_versions version
           where version.workspace_id = ${transaction.workspaceId}
             and version.workflow_id = ${parsed.workflowId}
             and version.id = ${parsed.workflowVersionId})
        )`,
        status: RUN_STATUS.queued,
      })
      .returning({ acceptedAt: workflowRuns.createdAt });
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  const insertedRun = insertedRuns[0];
  if (insertedRun === undefined) {
    throw new IdempotencyRecordCorruptError();
  }
  await transaction.db.insert(runEvents).values({
    workspaceId: transaction.workspaceId,
    workflowRunId: runId,
    sequence: 1,
    type: 'run.queued',
    payload: { schemaVersion: 1 },
  });
  await transaction.db.insert(runCheckpoints).values({
    workflowRunId: runId,
    workspaceId: transaction.workspaceId,
    workflowVersionId: parsed.workflowVersionId,
    revision: 0,
    engineVersion: parsed.engineVersion,
    schedulerState: sql`${initialCheckpointJson}::jsonb`,
  });

  const payload = {
    schemaVersion: 1,
    workspaceId: transaction.workspaceId,
    outboxEventId,
    runId,
    ...(parsed.traceparent === undefined
      ? {}
      : { traceparent: parsed.traceparent }),
  } as const;
  await insertOutboxEvent(transaction, {
    id: outboxEventId,
    jobName: 'advance-workflow-run',
    schemaVersion: 1,
    aggregateType: 'workflow-run',
    aggregateId: runId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });

  const completedClaims = await transaction.db
    .update(idempotencyRecords)
    .set({
      resultRef,
      status: IDEMPOTENCY_STATUS.completed,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(idempotencyRecords.id, idempotencyRecordId),
        eq(idempotencyRecords.status, IDEMPOTENCY_STATUS.inProgress),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (completedClaims.length !== 1) {
    throw new IdempotencyRecordCorruptError();
  }

  return Object.freeze({
    acceptedAt: insertedRun.acceptedAt,
    duplicate: false,
    outboxEventId,
    runId,
    status: RUN_STATUS.queued,
  });
}
