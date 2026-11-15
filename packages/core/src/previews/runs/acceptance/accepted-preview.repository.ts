import { and, eq, sql } from 'drizzle-orm';
import { traceIdOf } from '@pertexo/workflow-model';
import {
  idempotencyRecords,
  previewAttempts,
  previewRuns,
} from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import { serializeStoredExecutionValue } from '../../../shared/stored-execution.js';
import { PREVIEW_STATUS } from '../../preview-state.js';
import type { resolvePreviewSample } from '../samples.repository.js';
import type { AcceptPreviewRunInput } from './preview-acceptance.types.js';
import type { resolveInput } from './replay.repository.js';

type PinnedSample = NonNullable<
  Awaited<ReturnType<typeof resolvePreviewSample>>
>;
type ResolvedInput = Awaited<ReturnType<typeof resolveInput>>;

/** One acceptance per idempotency key at a time, for this transaction. */
export async function lockPreviewAcceptanceKey(
  transaction: WorkspaceTransaction,
  key: string,
): Promise<void> {
  await transaction.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`,
  );
}

/** Claims the idempotency key for this preview run; false if another holds it. */
export async function claimPreviewIdempotency(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  { id, previewRunId }: Readonly<{ id: string; previewRunId: string }>,
): Promise<boolean> {
  const claims = await transaction.db
    .insert(idempotencyRecords)
    .values({
      id,
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
  return claims.length !== 0;
}

/** Completes the claim with what it accepted; false if it was not in progress. */
export async function completePreviewIdempotency(
  transaction: WorkspaceTransaction,
  id: string,
  resultRef: Record<string, unknown>,
): Promise<boolean> {
  const completedClaims = await transaction.db
    .update(idempotencyRecords)
    .set({ resultRef, status: 'completed', updatedAt: sql`now()` })
    .where(
      and(
        eq(idempotencyRecords.id, id),
        eq(idempotencyRecords.status, 'in_progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  return completedClaims.length === 1;
}

/** Inserts the accepted preview run: queued, or already done from a pinned sample. */
export async function insertAcceptedPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    sample,
    resolvedInput,
    variableSetRevision,
  }: Readonly<{
    previewRunId: string;
    sample: PinnedSample | undefined;
    resolvedInput: ResolvedInput;
    variableSetRevision: number | null;
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
          : (traceIdOf(input.traceparent) ?? null)),
      providerKey: sample === undefined ? (input.providerKey ?? null) : null,
      operationKey: sample === undefined ? (input.operationKey ?? null) : null,
      executableNodeJson: input.executableNode,
      variableSetRevision,
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
  return insertedRuns[0];
}

/** The single queued attempt an executed preview starts with. */
export async function insertQueuedPreviewAttempt(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    previewAttemptId,
  }: Readonly<{ previewRunId: string; previewAttemptId: string }>,
): Promise<void> {
  await transaction.db.insert(previewAttempts).values({
    id: previewAttemptId,
    workspaceId: transaction.workspaceId,
    previewRunId,
    status: PREVIEW_STATUS.queued,
    sideEffectClass: input.sideEffectClass,
    providerIdempotencyKey: input.providerIdempotencyKey ?? null,
  });
}
