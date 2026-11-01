import {
  appendAuditFact,
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
  serializeStoredExecutionValue,
} from '@pertexo/database/primitives';
import { requireTransactionConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';
import { connectionScope } from '../../tenant-access/resources/connections/scope.js';

import { resolvePreviewSample } from './samples.repository.js';

import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { lockActorArtifactReferences } from '../../artifacts/references/repository.js';
import { captureWorkspaceVariableRevision } from '../../variables/head.queries.js';

import {
  idempotencyRecords,
  previewAttempts,
  previewRuns,
} from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { PREVIEW_STATUS } from '../state.js';

import {
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
} from '../errors.js';
import {
  assertAdmission,
  assertPreviewActor,
  assertPreviewWorkflow,
} from './acceptance/authority.queries.js';
import type {
  AcceptPreviewRunInput,
  AcceptedPreviewRun,
} from './acceptance/contract.js';
import {
  PREVIEW_EXECUTION_TIMEOUT_MAX_MS,
  PREVIEW_RETENTION_MAX_MS,
} from './acceptance/limits.js';
import {
  readExistingAcceptance,
  resolveInput,
} from './acceptance/replay.queries.js';
export async function acceptPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
): Promise<AcceptedPreviewRun> {
  await assertPreviewActor(transaction, input.actorUserId);
  const resources = await assertPreviewWorkflow(
    transaction,
    input.actorUserId,
    input.workflowId,
    'workflow:update',
  );
  await transaction.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`preview:${transaction.workspaceId}:${input.scope}:${input.keyHash}`},0))`,
  );
  const existing = await readExistingAcceptance(transaction, input);
  if (existing !== null) return existing;

  const now = new Date();
  assertPreviewDeadlines(input, now);
  const draftGraph = await assertAdmission(
    transaction,
    input.workflowId,
    input.draftRevision,
  );
  const sample = await resolvePreviewSample(
    transaction,
    {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      ...(input.expectedSampleId === undefined
        ? {}
        : { expectedSampleId: input.expectedSampleId }),
    },
    draftGraph,
  );
  const resolvedInput =
    sample === undefined
      ? await resolveInput(transaction, input.workflowId, input.input, now)
      : {
          priorPreviewRunId: null,
          stored: serializeStoredExecutionValue({ kind: 'inline', value: {} }),
        };

  await assertPreviewInputAuthority(transaction, input, {
    resources,
    sample,
    resolvedInput,
  });
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
      operation: input.operation,
      scope: input.scope,
      keyHash: input.keyHash,
      requestHash: input.requestHash,
      status: 'in_progress',
      resourceId: previewRunId,
      resultRef: {},
      expiresAt: input.expiresAt,
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
    const raced = await readExistingAcceptance(transaction, input);
    if (raced === null) throw new PreviewAcceptanceCorruptError();
    return raced;
  }

  const insertedRun = await insertAcceptedPreviewRun(transaction, input, {
    previewRunId,
    sample,
    resolvedInput,
  });
  if (dispatch.kind === 'execution')
    await persistPreviewAttempt(transaction, input, {
      previewRunId,
      previewAttemptId: dispatch.previewAttemptId,
      outboxEventId: dispatch.outboxEventId,
    });
  await recordAcceptedPreview(transaction, input, { previewRunId, sample });
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
    expiresAt: input.expiresAt,
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

type PreviewSample = Awaited<ReturnType<typeof resolvePreviewSample>>;
function assertPreviewDeadlines(input: AcceptPreviewRunInput, now: Date): void {
  if (
    input.expiresAt.getTime() <= now.getTime() ||
    input.expiresAt.getTime() - now.getTime() > PREVIEW_RETENTION_MAX_MS
  )
    throw new PreviewAdmissionDeniedError('retention');
  const invalidDeadline =
    input.executionDeadlineAt.getTime() <= now.getTime() ||
    input.executionDeadlineAt.getTime() - now.getTime() >
      PREVIEW_EXECUTION_TIMEOUT_MAX_MS ||
    input.executionDeadlineAt.getTime() > input.expiresAt.getTime();
  if (invalidDeadline) throw new PreviewAdmissionDeniedError('deadline');
}
async function assertPreviewInputAuthority(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    resources,
    sample,
    resolvedInput,
  }: Readonly<{
    resources: Awaited<ReturnType<typeof assertPreviewWorkflow>>;
    sample: PreviewSample;
    resolvedInput: Awaited<ReturnType<typeof resolveInput>>;
  }>,
): Promise<void> {
  if (sample === undefined) {
    await requireTransactionConnectionBindings(
      transaction,
      connectionScope(
        { workspaceId: transaction.workspaceId, actorId: input.actorUserId },
        resources.role,
        'connection:use',
      ),
      Object.entries(input.executableNode.connectionRefs ?? {}).map(
        ([slot, id]) => ({
          id,
          path: `$.nodes.${input.nodeId}.connectionRefs.${slot}`,
        }),
      ),
    );
    await lockActorArtifactReferences(
      transaction,
      input.actorUserId,
      JSON.parse(resolvedInput.stored),
      resolvedInput.priorPreviewRunId ?? undefined,
    );
    await lockActorArtifactReferences(
      transaction,
      input.actorUserId,
      input.executableNode,
      resolvedInput.priorPreviewRunId ?? undefined,
    );
  }
}
async function insertAcceptedPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    sample,
    resolvedInput,
  }: Readonly<{
    previewRunId: string;
    sample: PreviewSample;
    resolvedInput: Awaited<ReturnType<typeof resolveInput>>;
  }>,
) {
  const insertedRuns = await transaction.db
    .insert(previewRuns)
    .values({
      id: previewRunId,
      workspaceId: transaction.workspaceId,
      workflowId: input.workflowId,
      draftRevision: input.draftRevision,
      draftFingerprint: input.draftFingerprint,
      nodeId: input.nodeId,
      definitionKey: input.definitionKey,
      definitionVersion: input.definitionVersion,
      executorKey: input.executorKey,
      executorVersion: input.executorVersion,
      executionDeadlineAt: input.executionDeadlineAt,
      actorUserId: input.actorUserId,
      idempotencyKeyHash: input.keyHash,
      requestHash: input.requestHash,
      requestId: input.requestId ?? null,
      traceId:
        input.traceId ??
        (input.traceparent === undefined
          ? null
          : input.traceparent.slice(3, 35)),
      providerKey: sample === undefined ? (input.providerKey ?? null) : null,
      operationKey: sample === undefined ? (input.operationKey ?? null) : null,
      executableNodeJson: input.executableNode,
      variableSetRevision: await captureWorkspaceVariableRevision(transaction),
      inputRef: sql`${resolvedInput.stored}::json`,
      priorPreviewRunId: resolvedInput.priorPreviewRunId,
      sideEffectClass: sample === undefined ? input.sideEffectClass : 'safe',
      mayContactProvider: sample === undefined && input.mayContactProvider,
      mayCauseExternalSideEffect:
        sample === undefined && input.mayCauseExternalSideEffect,
      dryRun: sample === undefined ? input.dryRun : 'not_supported',
      status:
        sample === undefined ? PREVIEW_STATUS.queued : PREVIEW_STATUS.succeeded,
      pinnedSampleId: sample?.id ?? null,
      outputRef:
        sample === undefined
          ? null
          : sql`${serializeStoredExecutionValue(sample.output)}::json`,
      completedAt: sample === undefined ? null : sql`clock_timestamp()`,
      traceparent: input.traceparent ?? null,
      expiresAt: input.expiresAt,
    })
    .returning({
      acceptedAt: previewRuns.createdAt,
      completedAt: previewRuns.completedAt,
    });
  const insertedRun = insertedRuns[0];
  if (insertedRun === undefined) throw new PreviewAcceptanceCorruptError();

  return insertedRun;
}
async function recordAcceptedPreview(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    sample,
  }: Readonly<{ previewRunId: string; sample: PreviewSample }>,
): Promise<void> {
  await appendAuditFact(transaction, {
    workspaceId: transaction.workspaceId,
    actorId: input.actorUserId,
    action: 'preview.execution_accepted',
    targetType: 'preview-run',
    targetId: previewRunId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      sideEffectClass: sample === undefined ? input.sideEffectClass : 'safe',
      mayContactProvider: sample === undefined && input.mayContactProvider,
      mayCauseExternalSideEffect:
        sample === undefined && input.mayCauseExternalSideEffect,
      ...(sample === undefined ? {} : { pinnedSampleId: sample.id }),
      dryRun: sample === undefined ? input.dryRun : 'not_supported',
      expiresAt: input.expiresAt.toISOString(),
    },
  });
}

async function persistPreviewAttempt(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    previewAttemptId,
    outboxEventId,
  }: Readonly<{
    previewRunId: string;
    previewAttemptId: string;
    outboxEventId: string;
  }>,
): Promise<void> {
  await transaction.db.insert(previewAttempts).values({
    id: previewAttemptId,
    workspaceId: transaction.workspaceId,
    previewRunId,
    status: PREVIEW_STATUS.queued,
    sideEffectClass: input.sideEffectClass,
    providerIdempotencyKey: input.providerIdempotencyKey ?? null,
  });

  const payload = {
    workspaceId: transaction.workspaceId,
    outboxEventId,
    previewRunId,
    previewAttemptId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
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
