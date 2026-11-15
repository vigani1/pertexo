import { decodeStoredValue } from '../../../shared/stored-values.js';

import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../../shared/stored-execution.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { PREVIEW_STATUS } from '../../preview-state.js';

import {
  PreviewAcceptanceCorruptError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
} from '../../preview.errors.js';
import type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
} from './preview-acceptance.types.js';
import { resultRefSchema } from './preview-result.schemas.js';
import {
  readAcceptanceReceipt,
  readPriorPreviewOutput,
} from './replay.repository.js';

export async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    AcceptPreviewRunInput,
    'keyHash' | 'operation' | 'requestHash' | 'scope'
  >,
): Promise<AcceptedPreviewRun | null> {
  const row = await readAcceptanceReceipt(transaction, input);
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
          pinnedOutput: decodeStoredValue(() =>
            parseStoredExecutionValue(row.outputRef),
          ),
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
  const outputRef = await readPriorPreviewOutput(
    transaction,
    workflowId,
    input.previewRunId,
    now,
  );
  if (outputRef === undefined || outputRef === null)
    throw new PriorPreviewInputUnavailableError();
  return Object.freeze({
    priorPreviewRunId: input.previewRunId,
    stored: serializeStoredExecutionValue(
      decodeStoredValue(() => parseStoredExecutionValue(outputRef)),
    ),
  });
}
