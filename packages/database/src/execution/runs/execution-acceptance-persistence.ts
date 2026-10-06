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
  reserveWorkflowCallAdmission,
  WorkflowCallAdmissionCorruptError,
  type WorkflowCallAdmissionProof,
} from '../workflow-calls/workflow-call-admission.js';
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
  callAdmission?: Extract<WorkflowCallAdmissionProof, { kind: 'allowed' }>;
  nativeRootInput?: Readonly<{ original: string | null }>;
}>;

type CanonicalAcceptanceInput = Omit<
  ParsedAcceptWorkflowRunInput,
  'triggerType'
> & {
  readonly triggerType:
    ParsedAcceptWorkflowRunInput['triggerType'] | 'workflow_call';
};

/** Persist a won acceptance claim on the caller's existing workspace transaction. */
export async function persistWorkflowRunAcceptance(
  transaction: WorkspaceTransaction,
  parsed: CanonicalAcceptanceInput,
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
    callAdmission,
    nativeRootInput,
  } = prepared;
  if (
    (parsed.triggerType === 'workflow_call') !==
      (callAdmission !== undefined) ||
    (callAdmission !== undefined && callAdmission.candidateRunId !== runId)
  )
    throw new WorkflowCallAdmissionCorruptError();
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
          ${callAdmission?.deadlineAt ?? parsed.deadlineAt?.toISOString() ?? null}::timestamptz,
          (select now() +
             (case when version.schema_version=2 and version.executable_schema_version=3
               then coalesce(
                 (version.executable_json #>> '{graph,settings,maxRunDurationMs}')::integer,
                 (version.executable_json #>> '{familyPolicy,defaultMaxRunDurationMs}')::integer
               )
               else (version.executable_json #>> '{graph,settings,maxRunDurationMs}')::integer
             end)
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
    if (callAdmission !== undefined) throw error;
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

  if (callAdmission !== undefined)
    await reserveWorkflowCallAdmission(
      transaction,
      callAdmission,
      outboxEventId,
    );

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
  if (nativeRootInput !== undefined) {
    if (callAdmission !== undefined)
      throw new WorkflowCallAdmissionCorruptError();
    // The same canonical transaction owns run/checkpoint/outbox/claim and input
    // provenance. Any protected-source rejection rolls all of them back. The
    // SQL owner independently verifies actual native version and acceptance;
    // this optional captured material is not an authority flag.
    await transaction.db.execute(sql`
      select app.record_native_root_execution_input(
        ${runId}::uuid,${idempotencyRecordId}::uuid,${nativeRootInput.original}::text
      )
    `);
  }

  return Object.freeze({
    acceptedAt: insertedRun.acceptedAt,
    duplicate: false,
    outboxEventId,
    runId,
    status: RUN_STATUS.queued,
  });
}
