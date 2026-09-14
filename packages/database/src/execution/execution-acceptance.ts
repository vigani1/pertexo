import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum, insertOutboxEvent } from './outbox.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import {
  parseInitialWorkflowCheckpoint,
  serializePersistedWorkflowCheckpoint,
} from '../compatibility/persisted-workflow-checkpoint.js';
import {
  idempotencyRecords,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../schema.js';
import { serializeStoredExecutionValueV1 } from './stored-execution-value.js';
import { resolveWorkflowFailureNotificationPolicy } from './failure-notification-policy.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import { sha256HexSchema as sha256Schema } from '../validation/persisted-primitives.js';
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();

const acceptWorkflowRunInputSchema = z
  .object({
    engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    initialCheckpoint: z.unknown(),
    deadlineAt: z.date().optional(),
    keyHash: sha256Schema,
    operation: z.literal('workflow.run.accept'),
    requestHash: sha256Schema,
    replayCommandId: z.uuid().optional(),
    replaySourceRunId: z.uuid().optional(),
    runInput: z.unknown().optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    traceparent: traceparentSchema,
    triggerType: z.enum(['api', 'manual', 'replay', 'schedule', 'webhook']),
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

export class RegionalWriteAdmissionPausedError extends Error {
  public override readonly name = 'RegionalWriteAdmissionPausedError';
  public readonly retryAfterSeconds = 5;

  public constructor() {
    super('regional.write_admission_paused');
  }
}

type AdmissionSqlState = 'PTA01' | 'PTA02' | 'PTA03';

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
      if (code === 'PTA01' || code === 'PTA02' || code === 'PTA03') return code;
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
  if (code === 'PTA03') throw new RegionalWriteAdmissionPausedError();
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

export async function acceptWorkflowRun(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowRunInput,
): Promise<AcceptedWorkflowRun> {
  const parsed = acceptWorkflowRunInputSchema.parse(input);
  const storedRunInputJson =
    parsed.runInput === undefined
      ? null
      : serializeStoredExecutionValueV1({
          schemaVersion: 1,
          kind: 'inline',
          value: parsed.runInput,
        });
  if (
    (parsed.replayCommandId === undefined) !==
    (parsed.replaySourceRunId === undefined)
  )
    throw new TypeError('Replay lineage must be provided together');
  if (
    (parsed.triggerType === 'replay') !==
    (parsed.replayCommandId !== undefined)
  )
    throw new TypeError('Replay lineage must match the replay trigger type');
  const initialCheckpointJson = serializePersistedWorkflowCheckpoint(
    parseInitialWorkflowCheckpoint(parsed.initialCheckpoint, {
      engineVersion: parsed.engineVersion,
      workflowVersionId: parsed.workflowVersionId,
    }),
  );
  const initialCheckpointHash = createHash('sha256')
    .update(initialCheckpointJson)
    .digest('hex');
  const existing = await readExistingAcceptance(transaction, parsed, {
    kind: 'exact_initial_checkpoint',
    hash: initialCheckpointHash,
  });
  if (existing !== null) return existing;

  try {
    await transaction.db.execute(
      sql`select app.assert_regional_write_admission()`,
    );
    await assertWorkspaceAcceptsNewRuns(transaction);
  } catch (error: unknown) {
    throwWorkflowRunAdmissionError(error);
  }
  const failureNotificationPolicy =
    await resolveWorkflowFailureNotificationPolicy(
      transaction,
      parsed.workflowId,
    );
  const idempotencyRecordId = generatePersistedId();
  const runId = generatePersistedId();
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
        ...(parsed.deadlineAt === undefined
          ? {}
          : { deadlineAt: parsed.deadlineAt }),
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
