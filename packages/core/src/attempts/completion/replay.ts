import { canonicalJson } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { NodeAttemptStateCorruptError } from '../node-attempt.errors.js';
import {
  SETTLED_ATTEMPT_STATUSES,
  type CompleteAttemptInput,
  type CompleteNodeAttemptResult,
} from '../node-attempt.js';
import { completeReceipt } from './receipts.repository.js';

import { serializeStoredExecutionValue } from '../../shared/stored-execution.js';
import { assertConnectionHealthReplay } from './connection-health.repository.js';
import type {
  CompletionReceiptRow,
  LockedAttemptRow,
  CompletionFields,
} from './attempt-completion.types.js';

export async function duplicateCompletion(
  client: PoolClient,
  input: CompleteAttemptInput,
  {
    row,
    receipt,
    serializedOutput,
    fields,
  }: Readonly<{
    row: LockedAttemptRow;
    receipt: CompletionReceiptRow;
    serializedOutput: string | null;
    fields: CompletionFields;
  }>,
): Promise<CompleteNodeAttemptResult | undefined> {
  if (!SETTLED_ATTEMPT_STATUSES.includes(row.attemptStatus)) return undefined;
  await assertConnectionHealthReplay(client, input);
  const persistedOutput =
    row.outputRef === null
      ? null
      : serializeStoredExecutionValue(row.outputRef);
  const executorMismatch = executorCompletionMismatch(row, fields);
  const completionMismatch =
    row.attemptStatus !== fields.durableStatus ||
    (fields.executorOutcome === undefined &&
      input.outcome.status !== 'suspended' &&
      row.nodeStatus !== fields.durableStatus) ||
    (input.outcome.status === 'suspended' && !row.suspensionRecorded) ||
    persistedOutput !== serializedOutput ||
    row.safeErrorCode !== fields.safeErrorCode ||
    row.errorSummary !== fields.errorSummary ||
    canonicalJson(row.codeDiagnostics) !==
      canonicalJson(input.codeDiagnostics ?? null) ||
    executorMismatch;
  if (completionMismatch) {
    throw new NodeAttemptStateCorruptError();
  }
  if (receipt.completedAt === null) {
    await completeReceipt(
      client,
      input.lease.workspaceId,
      input.lease.delivery,
    );
  }
  return Object.freeze({ kind: 'duplicate' as const, outboxEventId: null });
}

function executorCompletionMismatch(
  row: LockedAttemptRow,
  fields: CompletionFields,
): boolean {
  return (
    fields.executorOutcome !== undefined &&
    (row.executorFailureKind !== fields.executorOutcome.failureKind ||
      row.executorErrorKind !== fields.executorOutcome.errorKind ||
      row.executorPossiblyDispatched !==
        fields.executorOutcome.possiblyDispatched ||
      row.executorRetryAfterMillis !==
        (fields.executorOutcome.minimumRetryDelayMillis ?? null) ||
      row.retryDecision === null)
  );
}
