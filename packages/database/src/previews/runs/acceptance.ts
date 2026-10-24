import { requireTransactionConnectionBindings } from '../../tenant-access/resources/connections/bindings.js';
import { connectionScope } from '../../tenant-access/resources/connections/scope.js';

import { resolvePreviewSample } from './samples.js';

import { captureWorkspaceVariableRevision } from '../../variables/settings.queries.js';
import { lockActorArtifactReferences } from '../../artifacts/references/repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../outbox/events.js';

import { PREVIEW_STATUS } from '../contract.js';
import {
  auditEvents,
  idempotencyRecords,
  previewAttempts,
  previewRuns,
} from '../../schema.js';
import { serializeStoredExecutionValue } from '../../platform/stored-execution-value.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

import {
  PREVIEW_RETENTION_MAX_MS,
  PREVIEW_EXECUTION_TIMEOUT_MAX_MS,
  acceptPreviewRunInputSchema,
  type AcceptPreviewRunInput,
  type AcceptedPreviewRun,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
} from './acceptance/contract.js';
import { readExistingAcceptance, resolveInput } from './acceptance/replay.js';
import {
  assertAdmission,
  assertPreviewActor,
  assertPreviewWorkflow,
} from './acceptance/authority.js';
export { PREVIEW_STATUS } from '../contract.js';
export type { PreviewStatus } from '../contract.js';
export {
  PREVIEW_RETENTION_MAX_MS,
  type AcceptPreviewRunInput,
  type AcceptedPreviewRun,
  type PreviewRunRecord,
  PreviewIdempotencyConflictError,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
  PriorPreviewInputUnavailableError,
} from './acceptance/contract.js';
export { readExistingAcceptance } from './acceptance/replay.js';
export {
  assertPreviewActor,
  previewWorkflowVisible,
} from './acceptance/authority.js';
export async function acceptPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
): Promise<AcceptedPreviewRun> {
  const parsed = acceptPreviewRunInputSchema.parse(input);
  await assertPreviewActor(transaction, parsed.actorUserId);
  const resources = await assertPreviewWorkflow(
    transaction,
    parsed.actorUserId,
    parsed.workflowId,
    'workflow:update',
  );
  await transaction.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`preview:${transaction.workspaceId}:${parsed.scope}:${parsed.keyHash}`},0))`,
  );
  const existing = await readExistingAcceptance(transaction, parsed);
  if (existing !== null) return existing;

  const now = new Date();
  assertPreviewDeadlines(parsed, now);
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

  await assertPreviewInputAuthority(transaction, parsed, {
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

  const insertedRun = await insertAcceptedPreviewRun(transaction, parsed, {
    previewRunId,
    sample,
    resolvedInput,
  });
  if (dispatch.kind === 'execution')
    await persistPreviewAttempt(transaction, parsed, {
      previewRunId,
      previewAttemptId: dispatch.previewAttemptId,
      outboxEventId: dispatch.outboxEventId,
    });
  await recordAcceptedPreview(transaction, parsed, { previewRunId, sample });
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

type ParsedPreviewInput = ReturnType<typeof acceptPreviewRunInputSchema.parse>;
type PreviewSample = Awaited<ReturnType<typeof resolvePreviewSample>>;
function assertPreviewDeadlines(parsed: ParsedPreviewInput, now: Date): void {
  if (
    parsed.expiresAt.getTime() <= now.getTime() ||
    parsed.expiresAt.getTime() - now.getTime() > PREVIEW_RETENTION_MAX_MS
  )
    throw new PreviewAdmissionDeniedError('retention');
  const invalidDeadline =
    parsed.executionDeadlineAt.getTime() <= now.getTime() ||
    parsed.executionDeadlineAt.getTime() - now.getTime() >
      PREVIEW_EXECUTION_TIMEOUT_MAX_MS ||
    parsed.executionDeadlineAt.getTime() > parsed.expiresAt.getTime();
  if (invalidDeadline) throw new PreviewAdmissionDeniedError('deadline');
}
async function assertPreviewInputAuthority(
  transaction: WorkspaceTransaction,
  parsed: ParsedPreviewInput,
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
        { workspaceId: transaction.workspaceId, actorId: parsed.actorUserId },
        resources.role,
        'connection:use',
      ),
      Object.entries(parsed.executableNode.connectionRefs ?? {}).map(
        ([slot, id]) => ({
          id,
          path: `$.nodes.${parsed.nodeId}.connectionRefs.${slot}`,
        }),
      ),
    );
    await lockActorArtifactReferences(
      transaction,
      parsed.actorUserId,
      JSON.parse(resolvedInput.stored) as unknown,
      resolvedInput.priorPreviewRunId ?? undefined,
    );
    await lockActorArtifactReferences(
      transaction,
      parsed.actorUserId,
      parsed.executableNode,
      resolvedInput.priorPreviewRunId ?? undefined,
    );
  }
}
async function insertAcceptedPreviewRun(
  transaction: WorkspaceTransaction,
  parsed: ParsedPreviewInput,
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
      inputRef: sql`${resolvedInput.stored}::json`,
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
          : sql`${serializeStoredExecutionValue(sample.output)}::json`,
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

  return insertedRun;
}
async function recordAcceptedPreview(
  transaction: WorkspaceTransaction,
  parsed: ParsedPreviewInput,
  {
    previewRunId,
    sample,
  }: Readonly<{ previewRunId: string; sample: PreviewSample }>,
): Promise<void> {
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
}

async function persistPreviewAttempt(
  transaction: WorkspaceTransaction,
  parsed: ParsedPreviewInput,
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
