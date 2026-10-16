import { definitionIdentitySchema } from '@pertexo/node-sdk';
import { resolvePreviewSample } from './samples.js';
import { rolesForCapability } from '../../tenant-access/policy.js';
import { captureWorkspaceVariableRevision } from '../../variables/read.js';
import { lockExecutionArtifactReferences } from '../../artifacts/references.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../outbox/events.js';
import { executableNodeSchema } from '../executable-node.js';
import {
  PREVIEW_STATUS,
  traceparentSchema,
  type PreviewStatus,
} from '../contract.js';
export { PREVIEW_STATUS } from '../contract.js';
export type { PreviewStatus } from '../contract.js';
import {
  auditEvents,
  idempotencyRecords,
  previewAttempts,
  previewRuns,
  workflowDrafts,
  workspaceMemberships,
  workspaces,
  users,
  workflows,
} from '../../schema.js';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../platform/stored-execution-value.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';

const identityKeySchema = definitionIdentitySchema.shape.key;
const integrationKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]*$/u);
export const PREVIEW_RETENTION_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
const PREVIEW_EXECUTION_TIMEOUT_MAX_MS = 5 * 60 * 1_000;

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
    definitionKey: identityKeySchema,
    definitionVersion: z.number().int().positive(),
    draftFingerprint: sha256HexSchema,
    draftRevision: z.number().int().positive(),
    expectedSampleId: z.uuid().nullable().optional(),
    dryRun: z.enum(['not_supported', 'provider_supported']),
    executableNode: executableNodeSchema,
    executorKey: identityKeySchema,
    executorVersion: z.number().int().positive(),
    executionDeadlineAt: z.date(),
    expiresAt: z.date(),
    input: inputSourceSchema,
    keyHash: sha256HexSchema,
    mayContactProvider: z.boolean(),
    mayCauseExternalSideEffect: z.boolean(),
    nodeId: z.string().min(1).max(256),
    operation: z.literal('preview.execute'),
    operationKey: integrationKeySchema.max(128).optional(),
    providerKey: integrationKeySchema.max(64).optional(),
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    requestHash: sha256HexSchema,
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

const resultRefSchema = z.union([
  z.object({ outboxEventId: z.uuid(), previewAttemptId: z.uuid() }).strict(),
  z.object({ pinnedSampleId: z.uuid() }).strict(),
]);

type ParsedPreviewRunInput = z.input<typeof acceptPreviewRunInputSchema>;
export type AcceptPreviewRunInput = Readonly<
  Omit<ParsedPreviewRunInput, 'executableNode'> & {
    executableNode: Readonly<Record<string, unknown>>;
  }
>;

export type AcceptedPreviewRun = Readonly<{
  acceptedAt: Date;
  duplicate: boolean;
  expiresAt: Date;
  outboxEventId: string | null;
  previewAttemptId: string | null;
  pinnedSampleId?: string;
  pinnedOutput?: ReturnType<typeof parseStoredExecutionValue>;
  completedAt?: Date | null;
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
  output: ReturnType<typeof parseStoredExecutionValue> | null;
  pinnedSampleId?: string | null;
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

export async function readExistingAcceptance(
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
      pinnedSampleId: previewRuns.pinnedSampleId,
      outputRef: previewRuns.outputRef,
      completedAt: previewRuns.completedAt,
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
  if (
    'pinnedSampleId' in resultRef.data &&
    (row.pinnedSampleId !== resultRef.data.pinnedSampleId ||
      status.data !== PREVIEW_STATUS.succeeded ||
      row.outputRef === null)
  )
    throw new PreviewAcceptanceCorruptError();
  return Object.freeze({
    acceptedAt: row.acceptedAt,
    completedAt: row.completedAt,
    duplicate: true,
    expiresAt: row.expiresAt,
    outboxEventId:
      'outboxEventId' in resultRef.data ? resultRef.data.outboxEventId : null,
    previewAttemptId:
      'previewAttemptId' in resultRef.data
        ? resultRef.data.previewAttemptId
        : null,
    ...('pinnedSampleId' in resultRef.data
      ? {
          pinnedSampleId: resultRef.data.pinnedSampleId,
          pinnedOutput: parseStoredExecutionValue(row.outputRef),
        }
      : {}),
    previewRunId: row.resourceId,
    status: status.data,
  });
}

async function assertAdmission(
  transaction: WorkspaceTransaction,
  workflowId: string,
  draftRevision: number,
) {
  const workflow = await transaction.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('share')
    .limit(1);
  if (workflow.length !== 1) throw new PreviewAdmissionDeniedError('draft');
  const drafts = await transaction.db
    .select({
      revision: workflowDrafts.revision,
      graph: workflowDrafts.graphJson,
    })
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
  return drafts[0].graph;
}

export async function assertPreviewActor(
  transaction: WorkspaceTransaction,
  actorUserId: string,
): Promise<void> {
  const workspace = await transaction.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, transaction.workspaceId),
        eq(workspaces.status, 'active'),
      ),
    )
    .for('share')
    .limit(1);
  const actor = await transaction.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorUserId), eq(users.status, 'active')))
    .for('share')
    .limit(1);
  const membership = await transaction.db
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, transaction.workspaceId),
        eq(workspaceMemberships.userId, actorUserId),
        eq(workspaceMemberships.status, 'active'),
      ),
    )
    .for('share')
    .limit(1);
  if (
    workspace.length !== 1 ||
    actor.length !== 1 ||
    membership[0] === undefined ||
    !rolesForCapability('workflow:update').some(
      (role) => role === membership[0]?.role,
    )
  )
    throw new PreviewAdmissionDeniedError('actor');
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
      stored: serializeStoredExecutionValue({
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
    stored: serializeStoredExecutionValue(parseStoredExecutionValue(outputRef)),
  });
}

export async function acceptPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
): Promise<AcceptedPreviewRun> {
  const parsed = acceptPreviewRunInputSchema.parse(input);
  await assertPreviewActor(transaction, parsed.actorUserId);
  await transaction.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`preview:${transaction.workspaceId}:${parsed.scope}:${parsed.keyHash}`},0))`,
  );
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
  const draftGraph = await assertAdmission(
    transaction,
    parsed.workflowId,
    parsed.draftRevision,
  );
  const sample = await resolvePreviewSample(
    transaction,
    {
      workflowId: parsed.workflowId,
      nodeId: parsed.nodeId,
      ...(parsed.expectedSampleId === undefined
        ? {}
        : { expectedSampleId: parsed.expectedSampleId }),
    },
    draftGraph,
  );
  const resolvedInput =
    sample === undefined
      ? await resolveInput(transaction, parsed.workflowId, parsed.input, now)
      : {
          priorPreviewRunId: null,
          stored: serializeStoredExecutionValue({ kind: 'inline', value: {} }),
        };

  if (sample === undefined) {
    await lockExecutionArtifactReferences(
      transaction,
      JSON.parse(resolvedInput.stored) as unknown,
      resolvedInput.priorPreviewRunId ?? undefined,
    );
    await lockExecutionArtifactReferences(
      transaction,
      parsed.executableNode,
      resolvedInput.priorPreviewRunId ?? undefined,
    );
  }
  const idempotencyRecordId = uuidv7();
  const previewRunId = uuidv7();
  const dispatch =
    sample === undefined
      ? {
          kind: 'execution' as const,
          previewAttemptId: uuidv7(),
          outboxEventId: uuidv7(),
        }
      : { kind: 'pinned' as const, ...sample };
  const previewAttemptId =
    dispatch.kind === 'execution' ? dispatch.previewAttemptId : null;
  const outboxEventId =
    dispatch.kind === 'execution' ? dispatch.outboxEventId : null;
  const resultRef =
    sample === undefined
      ? { outboxEventId, previewAttemptId }
      : { pinnedSampleId: sample.id };

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
      actorUserId: parsed.actorUserId,
      idempotencyKeyHash: parsed.keyHash,
      requestHash: parsed.requestHash,
      requestId: parsed.requestId ?? null,
      traceId:
        parsed.traceId ??
        (parsed.traceparent === undefined
          ? null
          : parsed.traceparent.slice(3, 35)),
      providerKey: sample === undefined ? (parsed.providerKey ?? null) : null,
      operationKey: sample === undefined ? (parsed.operationKey ?? null) : null,
      executableNodeJson: parsed.executableNode,
      variableSetRevision: await captureWorkspaceVariableRevision(transaction),
      inputRef: sql`${resolvedInput.stored}::jsonb`,
      priorPreviewRunId: resolvedInput.priorPreviewRunId,
      sideEffectClass: sample === undefined ? parsed.sideEffectClass : 'safe',
      mayContactProvider: sample === undefined && parsed.mayContactProvider,
      mayCauseExternalSideEffect:
        sample === undefined && parsed.mayCauseExternalSideEffect,
      dryRun: sample === undefined ? parsed.dryRun : 'not_supported',
      status:
        sample === undefined ? PREVIEW_STATUS.queued : PREVIEW_STATUS.succeeded,
      pinnedSampleId: sample?.id ?? null,
      outputRef:
        sample === undefined
          ? null
          : sql`${serializeStoredExecutionValue(sample.output)}::jsonb`,
      completedAt: sample === undefined ? null : sql`clock_timestamp()`,
      traceparent: parsed.traceparent ?? null,
      expiresAt: parsed.expiresAt,
    })
    .returning({
      acceptedAt: previewRuns.createdAt,
      completedAt: previewRuns.completedAt,
    });
  const insertedRun = insertedRuns[0];
  if (insertedRun === undefined) throw new PreviewAcceptanceCorruptError();

  if (dispatch.kind === 'execution') {
    const { previewAttemptId, outboxEventId } = dispatch;
    await transaction.db.insert(previewAttempts).values({
      id: previewAttemptId,
      workspaceId: transaction.workspaceId,
      previewRunId,
      status: PREVIEW_STATUS.queued,
      sideEffectClass: parsed.sideEffectClass,
      providerIdempotencyKey: parsed.providerIdempotencyKey ?? null,
    });

    const payload = {
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
      aggregateType: 'preview-run',
      aggregateId: previewRunId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    });
  }
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
      workflowId: parsed.workflowId,
      nodeId: parsed.nodeId,
      sideEffectClass: sample === undefined ? parsed.sideEffectClass : 'safe',
      mayContactProvider: sample === undefined && parsed.mayContactProvider,
      mayCauseExternalSideEffect:
        sample === undefined && parsed.mayCauseExternalSideEffect,
      ...(sample === undefined ? {} : { pinnedSampleId: sample.id }),
      dryRun: sample === undefined ? parsed.dryRun : 'not_supported',
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
    completedAt: insertedRun.completedAt,
    duplicate: false,
    expiresAt: parsed.expiresAt,
    outboxEventId,
    previewAttemptId,
    previewRunId,
    status:
      sample === undefined ? PREVIEW_STATUS.queued : PREVIEW_STATUS.succeeded,
    ...(sample === undefined
      ? {}
      : { pinnedSampleId: sample.id, pinnedOutput: sample.output }),
  });
}
