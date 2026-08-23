import { randomUUID } from 'node:crypto';

import { and, eq, gt, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
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
} from './schema.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';
import { withTenantScopedClient } from './workspace.js';
import type { WorkspaceTransaction } from './workspace.js';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const compatibilityFingerprintSchema = z
  .string()
  .regex(/^node-compat:v1:sha256:[0-9a-f]{64}$/u);
const identityKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/u);
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16))
  .optional();
const executableNodeSchema = z
  .record(z.string(), z.json())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1_048_576,
  );

export const PREVIEW_RETENTION_MAX_MS = 24 * 60 * 60 * 1_000;

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
    expiresAt: z.date(),
    input: inputSourceSchema,
    keyHash: sha256Schema,
    mayContactProvider: z.boolean(),
    mayCauseExternalSideEffect: z.boolean(),
    nodeId: z.string().min(1).max(256),
    operation: z.literal('preview.execute'),
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
  public constructor(reason: 'actor' | 'draft' | 'retention') {
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

  const idempotencyRecordId = randomUUID();
  const previewRunId = randomUUID();
  const previewAttemptId = randomUUID();
  const outboxEventId = randomUUID();
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
      compatibilityReleaseEpoch: parsed.compatibilityReleaseEpoch,
      compatibilityReleaseFingerprint: parsed.compatibilityReleaseFingerprint,
      actorUserId: parsed.actorUserId,
      idempotencyKeyHash: parsed.keyHash,
      requestHash: parsed.requestHash,
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
    id: randomUUID(),
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
      mayCauseExternalSideEffect: parsed.mayCauseExternalSideEffect,
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

// ---------------------------------------------------------------------------
// Worker-side execution seam.
//
// The API role owns immutable preview identity (acceptance above). The worker
// owns only lifecycle columns granted by migration 0022 and every mutation is
// fenced by the monotonic attempt token under forced RLS. Deliveries bind to
// their durable outbox aggregate exactly like production node attempts, so a
// forged or drifted BullMQ payload can never drive a preview.
// ---------------------------------------------------------------------------

function optionsFor(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

const TERMINAL_PREVIEW_STATUSES: ReadonlySet<string> = new Set([
  PREVIEW_STATUS.canceled,
  PREVIEW_STATUS.failed,
  PREVIEW_STATUS.outcomeUnknown,
  PREVIEW_STATUS.succeeded,
  PREVIEW_STATUS.timedOut,
]);

const previewConsumerName = 'preview-attempt-worker';

const safeErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);

const previewDeliveryPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
    traceparent: traceparentSchema,
  })
  .strict();

export type PreviewDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type PreviewTerminalOutcome =
  | Readonly<{
      output: ReturnType<typeof parseStoredExecutionValueV1>;
      status: typeof PREVIEW_STATUS.succeeded;
    }>
  | Readonly<{
      safeErrorCode: z.output<typeof safeErrorCodeSchema>;
      status: Exclude<
        PreviewStatus,
        | typeof PREVIEW_STATUS.queued
        | typeof PREVIEW_STATUS.running
        | typeof PREVIEW_STATUS.succeeded
      >;
    }>;

export type PreviewAttemptLease = Readonly<{
  attemptFenceToken: number;
  // The tenant scope travels with every lease so worker code cannot mix
  // workspaces when composing capabilities or completing work.
  workspaceId: string;
  compatibilityReleaseEpoch: number;
  compatibilityReleaseFingerprint: string;
  definitionKey: string;
  definitionVersion: number;
  dryRun: 'not_supported' | 'provider_supported';
  executableNode: Readonly<Record<string, unknown>>;
  executorKey: string;
  executorVersion: number;
  expiresAt: Date;
  input: ReturnType<typeof parseStoredExecutionValueV1>;
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  nodeId: string;
  previewAttemptId: string;
  previewRunId: string;
  providerIdempotencyKey?: string;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  traceparent?: string;
  workflowId: string;
}>;

export class PreviewDeliveryMismatchError extends Error {
  public override readonly name = 'PreviewDeliveryMismatchError';
  public constructor() {
    super('Preview delivery does not match its durable outbox aggregate');
  }
}

export class PreviewAttemptStateError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super(`Preview attempt cannot continue: ${code}`);
    this.code = code;
    this.name = 'PreviewAttemptStateError';
  }
}

function previewPairConsistent(
  attemptStatus: string,
  runStatus: string,
): boolean {
  const allowed: Record<string, readonly string[]> = {
    canceled: [PREVIEW_STATUS.canceled],
    failed: [PREVIEW_STATUS.failed],
    outcome_unknown: [PREVIEW_STATUS.outcomeUnknown],
    queued: [PREVIEW_STATUS.queued],
    running: [PREVIEW_STATUS.queued, PREVIEW_STATUS.running],
    succeeded: [PREVIEW_STATUS.succeeded],
    timed_out: [PREVIEW_STATUS.timedOut],
  };
  return allowed[attemptStatus]?.includes(runStatus) ?? false;
}

async function validatePreviewDelivery(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  input: Readonly<{
    delivery: PreviewDelivery;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<void> {
  const result = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
    schema_version: number;
  }>(
    `select aggregate_id,aggregate_type,job_name,payload,
            payload_checksum,schema_version
     from app.outbox_events
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.delivery.outboxEventId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Under this workspace scope the aggregate does not exist: forced RLS
    // hides foreign work, so this is a scope violation, not tampering.
    throw new PreviewAttemptStateError('delivery_not_found');
  }
  let payload: z.output<typeof previewDeliveryPayloadSchema> | undefined;
  let checksum: string | undefined;
  try {
    payload = previewDeliveryPayloadSchema.parse(row.payload);
    checksum = canonicalOutboxPayloadChecksum(payload);
  } catch {
    throw new PreviewDeliveryMismatchError();
  }
  if (
    row.aggregate_id !== input.previewRunId ||
    row.aggregate_type !== 'preview-run' ||
    row.job_name !== 'execute-preview-attempt' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== input.delivery.payloadChecksum ||
    checksum !== row.payload_checksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.previewRunId !== input.previewRunId ||
    payload.previewAttemptId !== input.previewAttemptId ||
    payload.outboxEventId !== input.delivery.outboxEventId
  )
    throw new PreviewDeliveryMismatchError();
}

async function completePreviewReceipt(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<void> {
  const result = await client.query(
    `update app.inbox_receipts set completed_at=clock_timestamp()
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
       and payload_checksum=$4 and completed_at is null`,
    [
      previewConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (result.rowCount !== 1)
    throw new PreviewAttemptStateError('receipt_completion_lost');
}

async function auditPreviewDeliveryMismatch(
  pool: Pool,
  workspaceId: string,
  delivery: PreviewDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      await client.query(
        `insert into app.transport_security_audit_facts (
           id,workspace_id,fact_type,consumer_name,message_id
         ) values ($1,$2,'inbox_checksum_mismatch',$3,$4)`,
        [
          randomUUID(),
          workspaceId,
          previewConsumerName,
          delivery.outboxEventId,
        ],
      );
    },
    { signal },
  );
  throw new PreviewDeliveryMismatchError();
}

async function loadPreviewLease(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  input: Readonly<{
    attemptFenceToken: number;
    expiresAt: Date;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<PreviewAttemptLease> {
  const runs = await client.query<
    Readonly<{
      compatibility_release_epoch: number;
      compatibility_release_fingerprint: string;
      definition_key: string;
      definition_version: number;
      dry_run: string;
      executable_node_json: unknown;
      executor_key: string;
      executor_version: number;
      input_ref: unknown;
      may_contact_provider: boolean;
      may_cause_external_side_effect: boolean;
      node_id: string;
      side_effect_class: string;
      traceparent: string | null;
      workflow_id: string;
    }> & { run_expires_at: Date }
  >(
    `select compatibility_release_epoch,compatibility_release_fingerprint,
            definition_key,definition_version,dry_run,executable_node_json,
            executor_key,executor_version,input_ref,may_contact_provider,
            may_cause_external_side_effect,node_id,side_effect_class,
            traceparent,workflow_id,expires_at as run_expires_at
     from app.preview_runs
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.previewRunId],
  );
  const attempts = await client.query<{
    provider_idempotency_key: string | null;
    side_effect_class: string;
  }>(
    `select provider_idempotency_key,side_effect_class
     from app.preview_attempts
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.previewAttemptId],
  );
  const run = runs.rows[0];
  const attempt = attempts.rows[0];
  if (run === undefined || attempt === undefined)
    throw new PreviewAttemptStateError('pins_missing');
  const sideEffectClass = z
    .enum(['safe', 'idempotent_with_key', 'unsafe'])
    .parse(attempt.side_effect_class);
  return Object.freeze({
    // PostgreSQL bigint arrives as a string through node-postgres; coerce
    // at this boundary before the numeric contract applies.
    attemptFenceToken: z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(input.attemptFenceToken),
    workspaceId: input.workspaceId,
    compatibilityReleaseEpoch: run.compatibility_release_epoch,
    compatibilityReleaseFingerprint: run.compatibility_release_fingerprint,
    definitionKey: run.definition_key,
    definitionVersion: run.definition_version,
    dryRun: z.enum(['not_supported', 'provider_supported']).parse(run.dry_run),
    executableNode: Object.freeze(
      executableNodeSchema.parse(run.executable_node_json),
    ),
    executorKey: run.executor_key,
    executorVersion: run.executor_version,
    expiresAt: run.run_expires_at,
    input: parseStoredExecutionValueV1(run.input_ref),
    mayContactProvider: run.may_contact_provider,
    mayCauseExternalSideEffect: run.may_cause_external_side_effect,
    nodeId: run.node_id,
    previewAttemptId: input.previewAttemptId,
    previewRunId: input.previewRunId,
    ...(attempt.provider_idempotency_key === null
      ? {}
      : { providerIdempotencyKey: attempt.provider_idempotency_key }),
    sideEffectClass,
    ...(run.traceparent === null ? {} : { traceparent: run.traceparent }),
    workflowId: run.workflow_id,
  });
}

export type PreviewClaimResult =
  | Readonly<{ kind: 'claimed'; lease: PreviewAttemptLease }>
  | Readonly<{ kind: 'duplicate' }>;

export async function claimPreviewDelivery(
  pool: Pool,
  input: Readonly<{
    delivery: PreviewDelivery;
    leaseDurationSeconds: number;
    previewAttemptId: string;
    previewRunId: string;
    signal?: AbortSignal;
    workerId: string;
    workspaceId: string;
  }>,
): Promise<PreviewClaimResult> {
  const parsed = z
    .object({
      leaseDurationSeconds: z.number().int().positive().max(3_600),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse(input);
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: parsed.workspaceId },
      async (client): Promise<PreviewClaimResult> => {
        await validatePreviewDelivery(client, {
          delivery: input.delivery,
          previewAttemptId: parsed.previewAttemptId,
          previewRunId: parsed.previewRunId,
          workspaceId: parsed.workspaceId,
        });

        const receiptInserted = await client.query(
          `insert into app.inbox_receipts (
           consumer_name,message_id,workspace_id,payload_checksum
         ) values ($1,$2,$3,$4)
         on conflict (consumer_name,message_id) do nothing
         returning message_id`,
          [
            previewConsumerName,
            input.delivery.outboxEventId,
            parsed.workspaceId,
            input.delivery.payloadChecksum,
          ],
        );
        if (receiptInserted.rowCount === 0) {
          // A prior claim crashed before completing business work; durable
          // attempt state below decides whether redelivery may proceed. The
          // receipt completes only together with a terminal outcome.
          const existing = await client.query<{ completed_at: Date | null }>(
            `select completed_at from app.inbox_receipts
           where consumer_name=$1 and message_id=$2 and workspace_id=$3
           for update`,
            [
              previewConsumerName,
              input.delivery.outboxEventId,
              parsed.workspaceId,
            ],
          );
          const receipt = existing.rows[0];
          if (receipt === undefined)
            throw new PreviewAttemptStateError('receipt_missing');
          if (receipt.completed_at !== null)
            return Object.freeze({ kind: 'duplicate' });
        }

        const locked = await client.query<{
          attempt_status: string;
          dispatch_marked_at: Date | null;
          lease_expired: boolean | null;
          live_lease: boolean | null;
          run_status: string;
        }>(
          `select attempt.status as attempt_status,
                attempt.dispatch_marked_at,
                (attempt.lease_expires_at is not null
                   and attempt.lease_expires_at > clock_timestamp())
                  as live_lease,
                (attempt.lease_expires_at is not null
                   and attempt.lease_expires_at <= clock_timestamp())
                  as lease_expired,
                run.status as run_status
         from app.preview_attempts attempt
         join app.preview_runs run
           on run.workspace_id = attempt.workspace_id
          and run.id = attempt.preview_run_id
         where attempt.workspace_id=$1
           and attempt.id=$2
           and attempt.preview_run_id=$3
         for update of attempt, run`,
          [parsed.workspaceId, parsed.previewAttemptId, parsed.previewRunId],
        );
        const state = locked.rows[0];
        if (state === undefined)
          throw new PreviewAttemptStateError('attempt_not_found');
        if (!previewPairConsistent(state.attempt_status, state.run_status))
          throw new PreviewAttemptStateError('run_attempt_divergence');
        if (TERMINAL_PREVIEW_STATUSES.has(state.attempt_status)) {
          await completePreviewReceipt(
            client,
            parsed.workspaceId,
            input.delivery,
          );
          return Object.freeze({ kind: 'duplicate' });
        }
        if (state.attempt_status === 'running' && state.live_lease === true) {
          // Another live worker owns the single logical attempt; at-least-once
          // transport makes this delivery a concurrent duplicate.
          return Object.freeze({ kind: 'duplicate' });
        }
        if (
          state.attempt_status === 'running' &&
          state.dispatch_marked_at !== null
        )
          throw new PreviewAttemptStateError('expired_after_dispatch');

        const claimed = await client.query<{
          fence_token: number;
          lease_expires_at: Date;
        }>(
          `update app.preview_attempts
         set status='running',
             lease_owner=$4,
             lease_expires_at=clock_timestamp() + ($5::int * interval '1 second'),
             fence_token=fence_token + 1,
             started_at=coalesce(started_at, clock_timestamp()),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status in ('queued','running')
         returning fence_token,lease_expires_at`,
          [
            parsed.workspaceId,
            parsed.previewAttemptId,
            parsed.previewRunId,
            parsed.workerId,
            parsed.leaseDurationSeconds,
          ],
        );
        const claimedRow = claimed.rows[0];
        if (claimedRow === undefined)
          throw new PreviewAttemptStateError('claim_lost');
        await client.query(
          `update app.preview_runs
         set status='running',
             started_at=coalesce(started_at, clock_timestamp()),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and status='queued'`,
          [parsed.workspaceId, parsed.previewRunId],
        );
        const lease = await loadPreviewLease(client, {
          attemptFenceToken: claimedRow.fence_token,
          expiresAt: claimedRow.lease_expires_at,
          previewAttemptId: parsed.previewAttemptId,
          previewRunId: parsed.previewRunId,
          workspaceId: parsed.workspaceId,
        });
        return Object.freeze({ kind: 'claimed', lease });
      },
      optionsFor(input.signal),
    );
  } catch (error: unknown) {
    if (
      error instanceof PreviewDeliveryMismatchError &&
      !input.signal?.aborted
    ) {
      // A mismatched delivery is a durable tenant-scoped security fact. It
      // is written in its own transaction because the business transaction
      // above rolled back with the failure.
      await auditPreviewDeliveryMismatch(
        pool,
        parsed.workspaceId,
        input.delivery,
        input.signal ?? new AbortController().signal,
      );
    }
    throw error;
  }
}

export type PreviewHeartbeatResult = Readonly<{
  attemptLeaseExpiresAt: Date;
  runExpiresAt: Date;
}>;

export async function heartbeatPreviewLease(
  pool: Pool,
  input: Readonly<{
    lease: Pick<
      PreviewAttemptLease,
      'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
    >;
    leaseDurationSeconds: number;
    signal?: AbortSignal;
    workerId: string;
  }>,
): Promise<PreviewHeartbeatResult> {
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      leaseDurationSeconds: z.number().int().positive().max(3_600),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse({
      ...input.lease,
      leaseDurationSeconds: input.leaseDurationSeconds,
      workerId: input.workerId,
    });
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      const result = await client.query<{ attempt_lease_expires_at: Date }>(
        `update app.preview_attempts
         set lease_expires_at=clock_timestamp() + ($5::int * interval '1 second'),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running' and lease_owner=$4 and fence_token=$6
         returning lease_expires_at as attempt_lease_expires_at`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.leaseDurationSeconds,
          scope.attemptFenceToken,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new PreviewAttemptStateError('heartbeat_lost');
      const runs = await client.query<{ expires_at: Date }>(
        `select expires_at from app.preview_runs
         where workspace_id=$1 and id=$2`,
        [scope.workspaceId, scope.previewRunId],
      );
      const runRow = runs.rows[0];
      if (runRow === undefined)
        throw new PreviewAttemptStateError('run_missing');
      return Object.freeze({
        attemptLeaseExpiresAt: row.attempt_lease_expires_at,
        runExpiresAt: runRow.expires_at,
      });
    },
    optionsFor(input.signal),
  );
}

export async function markPreviewDispatched(
  pool: Pool,
  input: Readonly<{
    lease: Pick<
      PreviewAttemptLease,
      'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
    >;
    signal?: AbortSignal;
    workerId: string;
  }>,
): Promise<'committed'> {
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse({ ...input.lease, workerId: input.workerId });
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      const result = await client.query(
        `update app.preview_attempts
         set dispatch_marked_at=coalesce(dispatch_marked_at, clock_timestamp()),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running'
           and lease_owner=$4 and fence_token=$5`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.attemptFenceToken,
        ],
      );
      if (result.rowCount !== 1)
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      return 'committed' as const;
    },
    optionsFor(input.signal),
  );
}

export type PreviewCompletionResult = Readonly<{
  kind: 'committed' | 'duplicate';
}>;

export async function completePreviewAttempt(
  pool: Pool,
  input: Readonly<{
    lease: Pick<
      PreviewAttemptLease,
      'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
    >;
    outcome: PreviewTerminalOutcome;
    signal?: AbortSignal;
    workerId: string;
  }>,
): Promise<PreviewCompletionResult> {
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse({ ...input.lease, workerId: input.workerId });
  const outcome =
    input.outcome.status === PREVIEW_STATUS.succeeded
      ? ({
          status: PREVIEW_STATUS.succeeded,
          outputRef: serializeStoredExecutionValueV1(input.outcome.output),
        } as const)
      : ({
          safeErrorCode: safeErrorCodeSchema.parse(input.outcome.safeErrorCode),
          status: input.outcome.status,
        } as const);
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client): Promise<PreviewCompletionResult> => {
      const terminal = await client.query<{ id: string }>(
        `update app.preview_attempts
         set status=$6::varchar,
             output_ref=$7::jsonb,
             safe_error_code=$8::varchar,
             completed_at=clock_timestamp(),
             lease_owner=null,
             lease_expires_at=null,
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running' and lease_owner=$4 and fence_token=$5
         returning id`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.attemptFenceToken,
          outcome.status,
          outcome.status === PREVIEW_STATUS.succeeded
            ? JSON.stringify(outcome.outputRef)
            : null,
          outcome.status === PREVIEW_STATUS.succeeded
            ? null
            : outcome.safeErrorCode,
        ],
      );
      if (terminal.rowCount !== 1) {
        const current = await client.query<{
          output_ref: unknown;
          status: string;
        }>(
          `select status,output_ref from app.preview_attempts
           where workspace_id=$1 and id=$2`,
          [scope.workspaceId, scope.previewAttemptId],
        );
        const row = current.rows[0];
        if (row === undefined)
          throw new PreviewAttemptStateError('completion_lost');
        if (
          row.status !== outcome.status ||
          (outcome.status === PREVIEW_STATUS.succeeded &&
            row.output_ref === null)
        )
          throw new PreviewAttemptStateError('completion_lost');
        return Object.freeze({ kind: 'duplicate' });
      }
      const syncedRuns = await client.query<{ id: string }>(
        `update app.preview_runs
         set status=$3::varchar,
             output_ref=$4::jsonb,
             safe_error_code=$5::varchar,
             completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2
           and status in ('queued','running')
         returning id`,
        [
          scope.workspaceId,
          scope.previewRunId,
          outcome.status,
          outcome.status === PREVIEW_STATUS.succeeded
            ? JSON.stringify(outcome.outputRef)
            : null,
          outcome.status === PREVIEW_STATUS.succeeded
            ? null
            : outcome.safeErrorCode,
        ],
      );
      if (syncedRuns.rowCount !== 1)
        throw new PreviewAttemptStateError('run_sync_lost');
      return Object.freeze({ kind: 'committed' });
    },
    optionsFor(input.signal),
  );
}

export type PreviewReconciliationOutcome = Readonly<{
  status: typeof PREVIEW_STATUS.failed | typeof PREVIEW_STATUS.outcomeUnknown;
}>;

/**
 * Bounded stored-value contract check for executor outputs before a
 * succeeded completion is attempted.
 */
function isStrictJsonValue(value: unknown, depth: number): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((member) => isStrictJsonValue(member, depth + 1));
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.entries(value).every(
      ([key, member]) => key.length > 0 && isStrictJsonValue(member, depth + 1),
    );
  // Functions, symbols, bigints, class instances, and host objects are all
  // outside the stored-value contract.
  return false;
}

export function isValidStoredExecutionOutput(value: unknown): boolean {
  if (!isStrictJsonValue(value, 0)) return false;
  try {
    // Serialization alone can silently drop hostile members; a lossless
    // canonical roundtrip additionally proves byte-stable truth.
    const serialized = serializeStoredExecutionValueV1(value);
    const reparsed = parseStoredExecutionValueV1(serialized);
    return serializeStoredExecutionValueV1(reparsed) === serialized;
  } catch {
    return false;
  }
}

export async function reconcileExpiredPreviewAttempt(
  pool: Pool,
  input: Readonly<{
    previewAttemptId: string;
    previewRunId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<PreviewReconciliationOutcome> {
  const scope = z
    .object({
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .parse(input);
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client): Promise<PreviewReconciliationOutcome> => {
      const locked = await client.query<{
        attempt_status: string;
        dispatch_marked_at: Date | null;
        expired_or_absent: boolean;
      }>(
        `select attempt.status as attempt_status,
                attempt.dispatch_marked_at,
                (attempt.lease_expires_at is null
                   or attempt.lease_expires_at <= clock_timestamp())
                  as expired_or_absent
         from app.preview_attempts attempt
         where attempt.workspace_id=$1
           and attempt.id=$2
           and attempt.preview_run_id=$3
         for update`,
        [scope.workspaceId, scope.previewAttemptId, scope.previewRunId],
      );
      const state = locked.rows[0];
      if (state === undefined)
        throw new PreviewAttemptStateError('attempt_not_found');
      if (state.attempt_status === PREVIEW_STATUS.outcomeUnknown)
        return Object.freeze({ status: PREVIEW_STATUS.outcomeUnknown });
      if (state.attempt_status === PREVIEW_STATUS.failed)
        return Object.freeze({ status: PREVIEW_STATUS.failed });
      if (state.attempt_status !== 'running' || !state.expired_or_absent)
        throw new PreviewAttemptStateError('reconciliation_not_applicable');
      // ADR 007 truth: after a committed dispatch marker the external effect
      // may exist, so the only truthful terminal status is outcome_unknown.
      // Before any marker the worker provably sent nothing, so the attempt
      // failed without provider contact.
      const status =
        state.dispatch_marked_at === null
          ? PREVIEW_STATUS.failed
          : PREVIEW_STATUS.outcomeUnknown;
      const reconciliationRef =
        status === PREVIEW_STATUS.outcomeUnknown
          ? {
              schemaVersion: 1,
              reason: 'lease_expired_after_dispatch',
            }
          : {
              schemaVersion: 1,
              reason: 'lease_expired_before_dispatch',
            };
      const applied = await client.query<{ id: string }>(
        `update app.preview_attempts
         set status=$4::varchar,
             safe_error_code=$5::varchar,
             reconciliation_ref=$6::jsonb,
             completed_at=clock_timestamp(),
             lease_owner=null,
             lease_expires_at=null,
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running'
         returning id`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          status,
          status === PREVIEW_STATUS.outcomeUnknown
            ? 'preview.outcome_unknown'
            : 'preview.worker_lost_before_dispatch',
          JSON.stringify(reconciliationRef),
        ],
      );
      if (applied.rowCount !== 1)
        throw new PreviewAttemptStateError('reconciliation_lost');
      const syncedRuns = await client.query<{ id: string }>(
        `update app.preview_runs
         set status=$3::varchar,
             safe_error_code=$4::varchar,
             completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and status in ('queued','running')
         returning id`,
        [
          scope.workspaceId,
          scope.previewRunId,
          status,
          status === PREVIEW_STATUS.outcomeUnknown
            ? 'preview.outcome_unknown'
            : 'preview.worker_lost_before_dispatch',
        ],
      );
      if (syncedRuns.rowCount !== 1)
        throw new PreviewAttemptStateError('run_sync_lost');
      return Object.freeze({ status });
    },
    optionsFor(input.signal),
  );
}
