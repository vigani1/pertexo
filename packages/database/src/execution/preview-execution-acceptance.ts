import { and, eq, gt, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum, insertOutboxEvent } from './outbox.js';
import {
  auditEvents,
  idempotencyRecords,
  previewAttempts,
  previewRuns,
  workflowDrafts,
  workspaceMemberships,
  workspaces,
} from '../schema.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const compatibilityFingerprintSchema = z
  .string()
  .regex(/^node-compat:v1:sha256:[0-9a-f]{64}$/u);
const identityKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u);
const integrationKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]*$/u);
export const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();
export const executableNodeSchema = z
  .record(z.string(), z.json())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1_048_576,
  );

export const PREVIEW_RETENTION_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
const PREVIEW_EXECUTION_TIMEOUT_MAX_MS = 5 * 60 * 1_000;

export const PREVIEW_STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
});
export type PreviewStatus =
  (typeof PREVIEW_STATUS)[keyof typeof PREVIEW_STATUS];
const previewStatusSchema = z.enum(
  Object.values(PREVIEW_STATUS) as [PreviewStatus, ...PreviewStatus[]],
);

const inputSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), value: z.unknown() }).strict(),
  z
    .object({ kind: z.literal('prior_preview'), previewRunId: z.uuid() })
    .strict(),
]);

const acceptPreviewRunInputSchema = z
  .object({
    actorUserId: z.uuid(),
    compatibilityReleaseEpoch: z.number().int().positive(),
    compatibilityReleaseFingerprint: compatibilityFingerprintSchema,
    definitionKey: identityKeySchema,
    definitionVersion: z.number().int().positive(),
    draftFingerprint: sha256Schema,
    draftRevision: z.number().int().positive(),
    dryRun: z.enum(['not_supported', 'provider_supported']),
    executableNode: executableNodeSchema,
    executorKey: identityKeySchema,
    executorVersion: z.number().int().positive(),
    executionDeadlineAt: z.date(),
    expiresAt: z.date(),
    input: inputSourceSchema,
    keyHash: sha256Schema,
    mayContactProvider: z.boolean(),
    mayCauseExternalSideEffect: z.boolean(),
    nodeId: z.string().min(1).max(256),
    operation: z.literal('preview.execute'),
    operationKey: integrationKeySchema.max(128).optional(),
    providerKey: integrationKeySchema.max(64).optional(),
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    requestHash: sha256Schema,
    requestId: z.string().min(1).max(128).optional(),
    scope: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    sideEffectClass: z.enum(['safe', 'idempotent_with_key', 'unsafe']),
    traceId: z.string().min(1).max(128).optional(),
    traceparent: traceparentSchema,
    workflowId: z.uuid(),
  })
  .strict()
  .refine(
    (input) => !input.mayCauseExternalSideEffect || input.mayContactProvider,
    'external side effects require provider contact disclosure',
  )
  .refine(
    (input) =>
      input.sideEffectClass !== 'idempotent_with_key' ||
      input.providerIdempotencyKey !== undefined,
    'idempotent execution requires a provider idempotency key',
  )
  .refine(
    (input) =>
      (input.providerKey === undefined) === (input.operationKey === undefined),
    'provider and operation classification must be supplied together',
  );

const resultRefSchema = z
  .object({ outboxEventId: z.uuid(), previewAttemptId: z.uuid() })
  .strict();

export type AcceptPreviewRunInput = Readonly<
  z.input<typeof acceptPreviewRunInputSchema>
>;

export type AcceptedPreviewRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  expiresAt: Date;
  outboxEventId: string;
  previewAttemptId: string;
  previewRunId: string;
  status: PreviewStatus;
}>;

export type PreviewRunRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  draftRevision: number;
  nodeId: string;
  status: PreviewStatus;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  dryRun: 'not_supported' | 'provider_supported';
  output: ReturnType<typeof parseStoredExecutionValueV1> | null;
  safeErrorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
}>;

export class PreviewIdempotencyConflictError extends Error {
  public override readonly name = 'PreviewIdempotencyConflictError';
  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class PreviewAcceptanceCorruptError extends Error {
  public override readonly name = 'PreviewAcceptanceCorruptError';
  public constructor() {
    super('Persisted preview acceptance is incomplete or invalid');
  }
}

export class PreviewAdmissionDeniedError extends Error {
  public override readonly name = 'PreviewAdmissionDeniedError';
  public constructor(reason: 'actor' | 'deadline' | 'draft' | 'retention') {
    super(`preview.${reason}_denied`);
  }
}

export class PriorPreviewInputUnavailableError extends Error {
  public override readonly name = 'PriorPreviewInputUnavailableError';
  public constructor() {
    super('preview.input_unavailable');
  }
}

async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    z.output<typeof acceptPreviewRunInputSchema>,
    'keyHash' | 'operation' | 'requestHash' | 'scope'
  >,
): Promise<AcceptedPreviewRun | null> {
  const rows = await transaction.db
    .select({
      requestHash: idempotencyRecords.requestHash,
      resourceId: idempotencyRecords.resourceId,
      resultRef: idempotencyRecords.resultRef,
      idempotencyStatus: idempotencyRecords.status,
      acceptedAt: previewRuns.createdAt,
      expiresAt: previewRuns.expiresAt,
      previewStatus: previewRuns.status,
    })
    .from(idempotencyRecords)
    .leftJoin(
      previewRuns,
      and(
        eq(previewRuns.workspaceId, idempotencyRecords.workspaceId),
        eq(previewRuns.id, idempotencyRecords.resourceId),
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
  if (row === undefined) return null;
  if (row.requestHash !== input.requestHash)
    throw new PreviewIdempotencyConflictError();
  const resultRef = resultRefSchema.safeParse(row.resultRef);
  const status = previewStatusSchema.safeParse(row.previewStatus);
  if (
    row.idempotencyStatus !== 'completed' ||
    row.acceptedAt === null ||
    row.expiresAt === null ||
    !resultRef.success ||
    !status.success
  )
    throw new PreviewAcceptanceCorruptError();
  return Object.freeze({
    acceptedAt: row.acceptedAt,
    duplicate: true,
    expiresAt: row.expiresAt,
    outboxEventId: resultRef.data.outboxEventId,
    previewAttemptId: resultRef.data.previewAttemptId,
    previewRunId: row.resourceId,
    status: status.data,
  });
}

async function assertAdmission(
  transaction: WorkspaceTransaction,
  actorUserId: string,
  workflowId: string,
  draftRevision: number,
): Promise<void> {
  await assertPreviewActor(transaction, actorUserId);

  const drafts = await transaction.db
    .select({ revision: workflowDrafts.revision })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, transaction.workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .for('share')
    .limit(1);
  if (drafts[0]?.revision !== draftRevision)
    throw new PreviewAdmissionDeniedError('draft');
}

async function assertPreviewActor(
  transaction: WorkspaceTransaction,
  actorUserId: string,
): Promise<void> {
  const access = await transaction.db
    .select({
      membershipRole: workspaceMemberships.role,
      membershipStatus: workspaceMemberships.status,
      workspaceStatus: workspaces.status,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, transaction.workspaceId),
        eq(workspaceMemberships.userId, actorUserId),
      ),
    )
    .limit(1);
  const row = access[0];
  if (
    row?.workspaceStatus !== 'active' ||
    row.membershipStatus !== 'active' ||
    !['owner', 'admin', 'builder'].includes(row.membershipRole)
  )
    throw new PreviewAdmissionDeniedError('actor');
}

export async function readPreviewRun(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorUserId: string; previewRunId: string }>,
  now: Date = new Date(),
): Promise<PreviewRunRecord | null> {
  const actorUserId = z.uuid().parse(input.actorUserId);
  const previewRunId = z.uuid().parse(input.previewRunId);
  await assertPreviewActor(transaction, actorUserId);
  const rows = await transaction.db
    .select()
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.id, previewRunId),
        gt(previewRuns.expiresAt, now),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const status = previewStatusSchema.parse(row.status);
  const sideEffectClass = z
    .enum(['safe', 'idempotent_with_key', 'unsafe'])
    .parse(row.sideEffectClass);
  const dryRun = z
    .enum(['not_supported', 'provider_supported'])
    .parse(row.dryRun);
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    draftRevision: row.draftRevision,
    nodeId: row.nodeId,
    status,
    sideEffectClass,
    mayContactProvider: row.mayContactProvider,
    mayCauseExternalSideEffect: row.mayCauseExternalSideEffect,
    dryRun,
    output:
      row.outputRef === null
        ? null
        : parseStoredExecutionValueV1(row.outputRef),
    safeErrorCode: row.safeErrorCode,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  });
}

async function resolveInput(
  transaction: WorkspaceTransaction,
  workflowId: string,
  input: z.output<typeof inputSourceSchema>,
  now: Date,
): Promise<Readonly<{ priorPreviewRunId: string | null; stored: string }>> {
  if (input.kind === 'manual') {
    return Object.freeze({
      priorPreviewRunId: null,
      stored: serializeStoredExecutionValueV1({
        schemaVersion: 1,
        kind: 'inline',
        value: input.value,
      }),
    });
  }
  const rows = await transaction.db
    .select({ outputRef: previewRuns.outputRef })
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.workflowId, workflowId),
        eq(previewRuns.id, input.previewRunId),
        eq(previewRuns.status, PREVIEW_STATUS.succeeded),
        gt(previewRuns.expiresAt, now),
      ),
    )
    .limit(1);
  const outputRef = rows[0]?.outputRef;
  if (outputRef === undefined || outputRef === null)
    throw new PriorPreviewInputUnavailableError();
  return Object.freeze({
    priorPreviewRunId: input.previewRunId,
    stored: serializeStoredExecutionValueV1(
      parseStoredExecutionValueV1(outputRef),
    ),
  });
}

export async function acceptPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
): Promise<AcceptedPreviewRun> {
  const parsed = acceptPreviewRunInputSchema.parse(input);
  const existing = await readExistingAcceptance(transaction, parsed);
  if (existing !== null) return existing;

  const now = new Date();
  if (
    parsed.expiresAt.getTime() <= now.getTime() ||
    parsed.expiresAt.getTime() - now.getTime() > PREVIEW_RETENTION_MAX_MS
  )
    throw new PreviewAdmissionDeniedError('retention');
  if (
    parsed.executionDeadlineAt.getTime() <= now.getTime() ||
    parsed.executionDeadlineAt.getTime() - now.getTime() >
      PREVIEW_EXECUTION_TIMEOUT_MAX_MS ||
    parsed.executionDeadlineAt.getTime() > parsed.expiresAt.getTime()
  )
    throw new PreviewAdmissionDeniedError('deadline');
  await assertAdmission(
    transaction,
    parsed.actorUserId,
    parsed.workflowId,
    parsed.draftRevision,
  );
  const resolvedInput = await resolveInput(
    transaction,
    parsed.workflowId,
    parsed.input,
    now,
  );

  const idempotencyRecordId = uuidv7();
  const previewRunId = uuidv7();
  const previewAttemptId = uuidv7();
  const outboxEventId = uuidv7();
  const resultRef = { outboxEventId, previewAttemptId } as const;

  const claims = await transaction.db
    .insert(idempotencyRecords)
    .values({
      id: idempotencyRecordId,
      workspaceId: transaction.workspaceId,
      operation: parsed.operation,
      scope: parsed.scope,
      keyHash: parsed.keyHash,
      requestHash: parsed.requestHash,
      status: 'in_progress',
      resourceId: previewRunId,
      resultRef: {},
      expiresAt: parsed.expiresAt,
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
  if (claims.length === 0) {
    const raced = await readExistingAcceptance(transaction, parsed);
    if (raced === null) throw new PreviewAcceptanceCorruptError();
    return raced;
  }

  const insertedRuns = await transaction.db
    .insert(previewRuns)
    .values({
      id: previewRunId,
      workspaceId: transaction.workspaceId,
      workflowId: parsed.workflowId,
      draftRevision: parsed.draftRevision,
      draftFingerprint: parsed.draftFingerprint,
      nodeId: parsed.nodeId,
      definitionKey: parsed.definitionKey,
      definitionVersion: parsed.definitionVersion,
      executorKey: parsed.executorKey,
      executorVersion: parsed.executorVersion,
      executionDeadlineAt: parsed.executionDeadlineAt,
      compatibilityReleaseEpoch: parsed.compatibilityReleaseEpoch,
      compatibilityReleaseFingerprint: parsed.compatibilityReleaseFingerprint,
      actorUserId: parsed.actorUserId,
      idempotencyKeyHash: parsed.keyHash,
      requestHash: parsed.requestHash,
      requestId: parsed.requestId ?? null,
      traceId:
        parsed.traceId ??
        (parsed.traceparent === undefined
          ? null
          : parsed.traceparent.slice(3, 35)),
      providerKey: parsed.providerKey ?? null,
      operationKey: parsed.operationKey ?? null,
      executableNodeJson: parsed.executableNode,
      inputRef: sql`${resolvedInput.stored}::jsonb`,
      priorPreviewRunId: resolvedInput.priorPreviewRunId,
      sideEffectClass: parsed.sideEffectClass,
      mayContactProvider: parsed.mayContactProvider,
      mayCauseExternalSideEffect: parsed.mayCauseExternalSideEffect,
      dryRun: parsed.dryRun,
      status: PREVIEW_STATUS.queued,
      traceparent: parsed.traceparent ?? null,
      expiresAt: parsed.expiresAt,
    })
    .returning({ acceptedAt: previewRuns.createdAt });
  const insertedRun = insertedRuns[0];
  if (insertedRun === undefined) throw new PreviewAcceptanceCorruptError();

  await transaction.db.insert(previewAttempts).values({
    id: previewAttemptId,
    workspaceId: transaction.workspaceId,
    previewRunId,
    status: PREVIEW_STATUS.queued,
    sideEffectClass: parsed.sideEffectClass,
    providerIdempotencyKey: parsed.providerIdempotencyKey ?? null,
  });

  const payload = {
    schemaVersion: 1,
    workspaceId: transaction.workspaceId,
    outboxEventId,
    previewRunId,
    previewAttemptId,
    ...(parsed.traceparent === undefined
      ? {}
      : { traceparent: parsed.traceparent }),
  } as const;
  await insertOutboxEvent(transaction, {
    id: outboxEventId,
    jobName: 'execute-preview-attempt',
    schemaVersion: 1,
    aggregateType: 'preview-run',
    aggregateId: previewRunId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });
  await transaction.db.insert(auditEvents).values({
    id: uuidv7(),
    workspaceId: transaction.workspaceId,
    actorUserId: parsed.actorUserId,
    action: 'preview.execution_accepted',
    targetType: 'preview-run',
    targetId: previewRunId,
    requestId: parsed.requestId ?? null,
    traceId: parsed.traceId ?? null,
    metadata: {
      schemaVersion: 1,
      workflowId: parsed.workflowId,
      nodeId: parsed.nodeId,
      sideEffectClass: parsed.sideEffectClass,
      mayContactProvider: parsed.mayContactProvider,
      mayCauseExternalSideEffect: parsed.mayCauseExternalSideEffect,
      dryRun: parsed.dryRun,
      expiresAt: parsed.expiresAt.toISOString(),
    },
  });

  const completedClaims = await transaction.db
    .update(idempotencyRecords)
    .set({ resultRef, status: 'completed', updatedAt: sql`now()` })
    .where(
      and(
        eq(idempotencyRecords.id, idempotencyRecordId),
        eq(idempotencyRecords.status, 'in_progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (completedClaims.length !== 1) throw new PreviewAcceptanceCorruptError();

  return Object.freeze({
    acceptedAt: insertedRun.acceptedAt,
    duplicate: false,
    expiresAt: parsed.expiresAt,
    outboxEventId,
    previewAttemptId,
    previewRunId,
    status: PREVIEW_STATUS.queued,
  });
}
