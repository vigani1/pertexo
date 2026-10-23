import { utf8ByteLength } from '@pertexo/workflow-model';
import { requireRunTableReferences } from '../../data-tables/columns/references.js';
import { requireWorkflowConcurrency } from './concurrency.js';
export { WorkflowAlreadyRunningError } from './concurrency.js';
import { runInputRetentionSql } from '../data-policy.js';
import { variableRevisionForAcceptance } from './variables.js';
import { requireFormAdmission } from './forms.js';
import { and, eq, sql } from 'drizzle-orm';
import { lockExecutionArtifactReferences } from '../../artifacts/references.js';
import { z } from 'zod';

import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../outbox/events.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  idempotencyRecords,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../../schema.js';
import { prepareStoredExecutionValue } from '../../platform/stored-execution-value.js';
import type { RunInputValidator } from './initial-checkpoint.js';
import { resolveWorkflowFailureNotificationPolicy } from '../../notifications/policy.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { sha256HexSchema as sha256Schema } from '../../platform/persisted-primitives.js';
import { prepareWorkflowRunAcceptanceInput } from './acceptance-input.js';
import type { WorkflowRecoverySummary } from '../recovery/contract.js';
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

const acceptWorkflowRunInputSchema = z
  .object({
    initialCheckpoint: z.unknown(),
    validateInput: z
      .custom<RunInputValidator>((value) => typeof value === 'function')
      .optional(),
    deadlineAt: z.date().optional(),
    absoluteDeadlineAt: z.date().nullable().optional(),
    startedBy: z.uuid().optional(),
    keyHash: sha256Schema,
    operation: z.literal('workflow.run.accept'),
    requestHash: sha256Schema,
    replayCommandId: z.uuid().optional(),
    replaySourceRunId: z.uuid().optional(),
    runInput: z.unknown().optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    traceparent: traceparentSchema,
    triggerType: z.enum([
      'test',
      'api',
      'manual',
      'replay',
      'schedule',
      'webhook',
      'workflow_call',
      'workflow_error',
      'form',
    ]),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

const resultRefSchema = z
  .object({
    outboxEventId: z.uuid(),
    initialCheckpointHash: sha256Schema.optional(),
  })
  .strict();

export const RUN_STATUS = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export const RUN_STATUS_VALUES = Object.values(RUN_STATUS) as [
  RunStatus,
  ...RunStatus[],
];

export const IDEMPOTENCY_STATUS = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
} as const;

export type IdempotencyStatus =
  (typeof IDEMPOTENCY_STATUS)[keyof typeof IDEMPOTENCY_STATUS];
export const IDEMPOTENCY_STATUS_VALUES = Object.values(IDEMPOTENCY_STATUS) as [
  IdempotencyStatus,
  ...IdempotencyStatus[],
];

const workflowRunStatusSchema = z.enum(RUN_STATUS_VALUES);

export type AcceptWorkflowRunInput = Readonly<
  z.input<typeof acceptWorkflowRunInputSchema>
>;

export type AcceptedWorkflowRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  outboxEventId: string;
  runId: string;
  status: z.output<typeof workflowRunStatusSchema>;
}>;

export class IdempotencyRequestConflictError extends Error {
  public override readonly name = 'IdempotencyRequestConflictError';

  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class IdempotencyRecordCorruptError extends Error {
  public override readonly name = 'IdempotencyRecordCorruptError';

  public constructor() {
    super('Persisted workflow run acceptance is incomplete or invalid');
  }
}

export class WorkspaceRunAdmissionDeniedError extends Error {
  public override readonly name = 'WorkspaceRunAdmissionDeniedError';

  public constructor() {
    super('workspace.run_admission_denied');
  }
}

export class WorkspaceRunQuotaExceededError extends Error {
  public override readonly name = 'WorkspaceRunQuotaExceededError';
  public readonly retryAfterSeconds = 5;

  public constructor() {
    super('workspace.quota_exceeded');
  }
}

type AdmissionSqlState = 'PTA01' | 'PTA02';

function inspectAdmissionSqlState(error: unknown): AdmissionSqlState | null {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (
      (typeof current !== 'object' && typeof current !== 'function') ||
      current === null
    )
      return null;
    if (visited.has(current)) return null;
    visited.add(current);
    try {
      if (!(current instanceof Error)) return null;
      const code = Reflect.get(current, 'code') as unknown;
      if (code === 'PTA01' || code === 'PTA02') return code;
      current = Reflect.get(current, 'cause');
    } catch {
      return null;
    }
  }
  return null;
}

/** Operation-local SQLSTATE mapping for queued workflow-run admission. */
export function throwWorkflowRunAdmissionError(error: unknown): never {
  const code = inspectAdmissionSqlState(error);
  if (code === 'PTA02') throw new WorkspaceRunQuotaExceededError();
  if (code === 'PTA01') throw new WorkspaceRunAdmissionDeniedError();
  throw error;
}

async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const result = await transaction.db.execute<{ status: string }>(sql`
    select app.lock_workspace_run_admission(${transaction.workspaceId}) status
  `);

  if (result.rows[0]?.status !== 'active') {
    throw new WorkspaceRunAdmissionDeniedError();
  }
}

type ReplayValidation =
  | Readonly<{ kind: 'request_only' }>
  | Readonly<{ kind: 'exact_initial_checkpoint'; hash: string }>;

async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    z.output<typeof acceptWorkflowRunInputSchema>,
    'keyHash' | 'operation' | 'requestHash' | 'scope'
  >,
  replayValidation: ReplayValidation,
): Promise<AcceptedWorkflowRun | null> {
  const rows = await transaction.db
    .select({
      requestHash: idempotencyRecords.requestHash,
      resourceId: idempotencyRecords.resourceId,
      resultRef: idempotencyRecords.resultRef,
      idempotencyStatus: idempotencyRecords.status,
      acceptedAt: workflowRuns.createdAt,
      runStatus: workflowRuns.status,
    })
    .from(idempotencyRecords)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, idempotencyRecords.workspaceId),
        eq(workflowRuns.id, idempotencyRecords.resourceId),
      ),
    )
    .where(
      and(
        eq(idempotencyRecords.workspaceId, transaction.workspaceId),
        eq(idempotencyRecords.operation, input.operation),
        eq(idempotencyRecords.scope, input.scope),
        eq(idempotencyRecords.keyHash, input.keyHash),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return null;
  }
  if (row.requestHash !== input.requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  const resultRef = resultRefSchema.safeParse(row.resultRef);
  const runStatus = workflowRunStatusSchema.safeParse(row.runStatus);
  if (
    row.idempotencyStatus !== IDEMPOTENCY_STATUS.completed ||
    row.acceptedAt === null ||
    !resultRef.success ||
    !runStatus.success
  ) {
    throw new IdempotencyRecordCorruptError();
  }
  if (
    replayValidation.kind === 'exact_initial_checkpoint' &&
    resultRef.data.initialCheckpointHash !== replayValidation.hash
  ) {
    throw new IdempotencyRequestConflictError();
  }

  return Object.freeze({
    acceptedAt: row.acceptedAt,
    duplicate: true,
    outboxEventId: resultRef.data.outboxEventId,
    runId: row.resourceId,
    status: runStatus.data,
  });
}

const acceptanceReplayInputSchema = acceptWorkflowRunInputSchema.pick({
  keyHash: true,
  operation: true,
  requestHash: true,
  scope: true,
});

export type WorkflowRunAcceptanceReplayInput = Readonly<
  z.input<typeof acceptanceReplayInputSchema>
>;

/** Resolve a completed exact request replay before reading current workflow state. */
export async function readWorkflowRunAcceptanceReplay(
  transaction: WorkspaceTransaction,
  input: WorkflowRunAcceptanceReplayInput,
): Promise<AcceptedWorkflowRun | null> {
  const parsed = acceptanceReplayInputSchema.parse(input);
  return readExistingAcceptance(transaction, parsed, { kind: 'request_only' });
}

export type PreparedWorkflowRunAcceptance = Readonly<{
  runId?: string;
  variableSetRevision?: number | null;
  errorWorkflowOrigin?: boolean;
  recovery?: WorkflowRecoverySummary;
  failureNotificationPolicy: Awaited<
    ReturnType<typeof resolveWorkflowFailureNotificationPolicy>
  >;
}>;

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
  const parsed = acceptWorkflowRunInputSchema.parse(input);
  const preparedRunInput =
    parsed.runInput === undefined
      ? null
      : prepareStoredExecutionValue({
          kind: 'inline',
          value: parsed.runInput,
        });
  const storedRunInputJson = preparedRunInput?.json ?? null;
  const { initialCheckpointJson, initialCheckpointHash } =
    prepareWorkflowRunAcceptanceInput(parsed);
  const existing = await readExistingAcceptance(transaction, parsed, {
    kind: 'exact_initial_checkpoint',
    hash: initialCheckpointHash,
  });
  if (existing !== null) return existing;
  await requireFormAdmission(transaction, parsed, preparedRunInput?.value);
  parsed.validateInput?.(
    preparedRunInput?.value.kind === 'inline'
      ? preparedRunInput.value.value
      : undefined,
    storedRunInputJson === null ? 0 : utf8ByteLength(storedRunInputJson),
  );

  const prepared =
    preparation ??
    (await prepareWorkflowRunAcceptance(transaction, parsed.workflowId));
  const sourceOrigin =
    parsed.replaySourceRunId === undefined
      ? false
      : (
          await transaction.db
            .select({ origin: workflowRuns.errorWorkflowOrigin })
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.workspaceId, transaction.workspaceId),
                eq(workflowRuns.id, parsed.replaySourceRunId),
              ),
            )
            .limit(1)
        )[0]?.origin === true;
  const variableSetRevision = await variableRevisionForAcceptance(
    transaction,
    parsed.replaySourceRunId,
    prepared.variableSetRevision,
  );
  const { failureNotificationPolicy } = prepared;
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
      operation: parsed.operation,
      scope: parsed.scope,
      keyHash: parsed.keyHash,
      requestHash: parsed.requestHash,
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
    const racedAcceptance = await readExistingAcceptance(transaction, parsed, {
      kind: 'exact_initial_checkpoint',
      hash: initialCheckpointHash,
    });
    if (racedAcceptance === null) throw new IdempotencyRecordCorruptError();
    return racedAcceptance;
  }

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
      .values({
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
              recoveryEffectsAcknowledged:
                prepared.recovery.effectsAcknowledged,
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
            : sql`now() + ${sql.raw(runInputRetentionSql(parsed.triggerType))}`,
        variableSetRevision,
        triggerType: parsed.triggerType,
        startedBy: parsed.startedBy ?? null,
        absoluteDeadlineAt:
          parsed.absoluteDeadlineAt === undefined
            ? (parsed.deadlineAt ?? null)
            : parsed.absoluteDeadlineAt,
        errorWorkflowOrigin:
          parsed.triggerType === 'workflow_error' ||
          prepared.errorWorkflowOrigin === true ||
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
