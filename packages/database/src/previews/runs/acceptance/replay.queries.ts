import { and, eq, gt } from 'drizzle-orm';

import type { z } from 'zod';

import { PREVIEW_STATUS } from '../../contract.js';
import { idempotencyRecords, previewRuns } from '../../../schema.js';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../../platform/stored-execution-value.js';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

import type {
  inputSourceSchema,
  acceptPreviewRunInputSchema,
} from './contract.js';
import {
  previewStatusSchema,
  resultRefSchema,
  type AcceptedPreviewRun,
  PreviewIdempotencyConflictError,
  PreviewAcceptanceCorruptError,
  PriorPreviewInputUnavailableError,
} from './contract.js';

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
  const { acceptedAt, expiresAt } = row;
  const incompleteReceipt =
    row.idempotencyStatus !== 'completed' ||
    acceptedAt === null ||
    expiresAt === null ||
    !resultRef.success ||
    !status.success;
  if (incompleteReceipt) throw new PreviewAcceptanceCorruptError();
  const invalidPinnedReceipt =
    'pinnedSampleId' in resultRef.data &&
    (row.pinnedSampleId !== resultRef.data.pinnedSampleId ||
      status.data !== PREVIEW_STATUS.succeeded ||
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
    status: status.data,
  });
}

export async function resolveInput(
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
