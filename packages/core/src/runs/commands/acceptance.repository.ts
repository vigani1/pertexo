import { utf8ByteLength } from '@pertexo/workflow-model';
import { requireRunTableReferences } from '../../data-tables/columns/references.queries.js';
import { requireWorkflowConcurrency } from './concurrency.queries.js';
import { runInputRetentionSql } from '../data-policy.js';
import { variableRevisionForAcceptance } from './variables.repository.js';
import { requireFormAdmission } from './forms.queries.js';
import { and, eq, sql } from 'drizzle-orm';
import { lockExecutionArtifactReferences } from '../../artifacts/references/locks.repository.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import { prepareStoredExecutionValue } from '../values/stored-execution.js';
import {
  idempotencyRecords,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '@pertexo/database/schema';
import { resolveWorkflowFailureNotificationPolicy } from '../../notifications/policies/admission.queries.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { prepareWorkflowRunAcceptanceInput } from './acceptance-input.js';
import { RUN_STATUS, IDEMPOTENCY_STATUS } from './acceptance/vocabulary.js';
import type {
  AcceptWorkflowRunInput,
  AcceptedWorkflowRun,
  PreparedWorkflowRunAcceptance,
} from './acceptance/contract.js';
import { IdempotencyRecordCorruptError } from './acceptance/errors.js';
import { readExistingAcceptance } from './acceptance/replay.repository.js';
import {
  throwWorkflowRunAdmissionError,
  assertWorkspaceAcceptsNewRuns,
} from './acceptance/admission.repository.js';
/** Call spawn acquires ordinary admission prerequisites before its parent lock. */
export async function prepareWorkflowRunAcceptance(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<PreparedWorkflowRunAcceptance> {
  try {
    await assertWorkspaceAcceptsNewRuns(transaction);
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  return {
    failureNotificationPolicy: await resolveWorkflowFailureNotificationPolicy(
      transaction,
      workflowId,
    ),
  };
}

export async function acceptWorkflowRun(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowRunInput,
  preparation?: PreparedWorkflowRunAcceptance,
): Promise<AcceptedWorkflowRun> {
  const preparedRunInput =
    input.runInput === undefined
      ? null
      : prepareStoredExecutionValue({
          kind: 'inline',
          value: input.runInput,
        });
  const storedRunInputJson = preparedRunInput?.json ?? null;
  const { initialCheckpointJson, initialCheckpointHash } =
    prepareWorkflowRunAcceptanceInput(input);
  const existing = await readExistingAcceptance(transaction, input, {
    kind: 'exact_initial_checkpoint',
    hash: initialCheckpointHash,
  });
  if (existing !== null) return existing;
  await requireFormAdmission(transaction, input, preparedRunInput?.value);
  input.validateInput?.(
    preparedRunInput?.value.kind === 'inline'
      ? preparedRunInput.value.value
      : undefined,
    storedRunInputJson === null ? 0 : utf8ByteLength(storedRunInputJson),
  );

  const prepared =
    preparation ??
    (await prepareWorkflowRunAcceptance(transaction, input.workflowId));
  const sourceOrigin =
    input.replaySourceRunId === undefined
      ? false
      : ((
          await transaction.db
            .select({ origin: workflowRuns.errorWorkflowOrigin })
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.workspaceId, transaction.workspaceId),
                eq(workflowRuns.id, input.replaySourceRunId),
              ),
            )
            .limit(1)
        )[0]?.origin ?? false);
  const variableSetRevision = await variableRevisionForAcceptance(
    transaction,
    input.replaySourceRunId,
    prepared.variableSetRevision,
  );
  const idempotencyRecordId = generatePersistedId();
  const runId = prepared.runId ?? generatePersistedId();
  const outboxEventId = generatePersistedId();
  const resultRef = {
    outboxEventId,
    initialCheckpointHash,
  } as const;

  const insertedClaim = await transaction.db
    .insert(idempotencyRecords)
    .values({
      id: idempotencyRecordId,
      workspaceId: transaction.workspaceId,
      operation: input.operation,
      scope: input.scope,
      keyHash: input.keyHash,
      requestHash: input.requestHash,
      status: IDEMPOTENCY_STATUS.inProgress,
      resourceId: runId,
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

  if (insertedClaim.length === 0) {
    const racedAcceptance = await readExistingAcceptance(transaction, input, {
      kind: 'exact_initial_checkpoint',
      hash: initialCheckpointHash,
    });
    if (racedAcceptance === null) throw new IdempotencyRecordCorruptError();
    return racedAcceptance;
  }

  const insertedRun = await insertAcceptedWorkflowRun(transaction, input, {
    prepared,
    runId,
    storedRunInputJson,
    variableSetRevision,
    sourceOrigin,
  });
  await persistRunStart(transaction, input, {
    runId,
    outboxEventId,
    initialCheckpointJson,
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

type ParsedRunInput = AcceptWorkflowRunInput;
type RunAdmissionState = Readonly<{
  prepared: PreparedWorkflowRunAcceptance;
  runId: string;
  storedRunInputJson: string | null;
  variableSetRevision: number | null;
  sourceOrigin: boolean;
}>;
async function insertAcceptedWorkflowRun(
  transaction: WorkspaceTransaction,
  parsed: ParsedRunInput,
  state: RunAdmissionState,
) {
  let insertedRuns;
  await lockExecutionArtifactReferences(transaction, parsed.runInput);
  try {
    await requireWorkflowConcurrency(
      transaction,
      parsed.workflowId,
      parsed.triggerType,
    );
    if (parsed.triggerType !== 'test')
      await requireRunTableReferences(transaction, parsed.workflowVersionId);
    insertedRuns = await transaction.db
      .insert(workflowRuns)
      .values(acceptedWorkflowRunValues(transaction, parsed, state))
      .returning({ acceptedAt: workflowRuns.createdAt });
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  const insertedRun = insertedRuns[0];
  if (insertedRun === undefined) {
    throw new IdempotencyRecordCorruptError();
  }

  return insertedRun;
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
               * interval '1 millisecond'
           from app.workflow_versions version
           where version.workspace_id = ${transaction.workspaceId}
             and version.workflow_id = ${parsed.workflowId}
             and version.id = ${parsed.workflowVersionId})
        )`,
    status: RUN_STATUS.queued,
  };
}

async function persistRunStart(
  transaction: WorkspaceTransaction,
  parsed: ParsedRunInput,
  {
    runId,
    outboxEventId,
    initialCheckpointJson,
  }: Readonly<{
    runId: string;
    outboxEventId: string;
    initialCheckpointJson: string;
  }>,
): Promise<void> {
  await transaction.db.insert(runEvents).values({
    workspaceId: transaction.workspaceId,
    workflowRunId: runId,
    sequence: 1,
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

  const payload = {
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
    aggregateType: 'workflow-run',
    aggregateId: runId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });
}
