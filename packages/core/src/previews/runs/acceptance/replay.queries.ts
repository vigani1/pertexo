import { and, eq, gt } from 'drizzle-orm';

import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../../runs/values/stored-execution.js';
import { idempotencyRecords, previewRuns } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { PREVIEW_STATUS } from '../../state.js';

import {
  PreviewAcceptanceCorruptError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
} from '../../errors.js';
import type { AcceptedPreviewRun, AcceptPreviewRunInput } from './contract.js';
import { resultRefSchema } from './input.js';

export async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    AcceptPreviewRunInput,
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
  const status = row.previewStatus;
  const { acceptedAt, expiresAt } = row;
  const incompleteReceipt =
    row.idempotencyStatus !== 'completed' ||
    acceptedAt === null ||
    expiresAt === null ||
    !resultRef.success ||
    status === null;
  if (incompleteReceipt) throw new PreviewAcceptanceCorruptError();
  const invalidPinnedReceipt =
    'pinnedSampleId' in resultRef.data &&
    (row.pinnedSampleId !== resultRef.data.pinnedSampleId ||
      status !== PREVIEW_STATUS.succeeded ||
      row.outputRef === null);
  if (invalidPinnedReceipt) throw new PreviewAcceptanceCorruptError();
  return Object.freeze({
    acceptedAt,
    completedAt: row.completedAt,
    duplicate: true,
    expiresAt,
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
    status: status,
  });
}

export async function resolveInput(
  transaction: WorkspaceTransaction,
  workflowId: string,
  input: AcceptPreviewRunInput['input'],
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
