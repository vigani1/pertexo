import { canonicalJson } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { NodeAttemptStateCorruptError } from '../contract.js';
import type { CompleteNodeAttemptResult } from '../contract.js';
import { completeReceipt } from './receipts.repository.js';

import { serializeStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { assertConnectionHealthReplay } from './connection-health.repository.js';
import type {
  CompletionInput,
  CompletionReceiptRow,
  LockedAttemptRow,
  CompletionFields,
} from './contract.js';

export async function duplicateCompletion(
  client: PoolClient,
  input: CompletionInput,
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
  if (
    ![
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ].includes(row.attempt_status)
  ) {
    return undefined;
  }
  await assertConnectionHealthReplay(client, input);
  const persistedOutput =
    row.output_ref === null
      ? null
      : serializeStoredExecutionValue(row.output_ref);
  const executorMismatch = executorCompletionMismatch(row, fields);
  const completionMismatch =
    row.attempt_status !== fields.durableStatus ||
    (fields.executorOutcome === undefined &&
      input.outcome.status !== 'suspended' &&
      row.node_status !== fields.durableStatus) ||
    (input.outcome.status === 'suspended' && !row.suspension_recorded) ||
    persistedOutput !== serializedOutput ||
    row.safe_error_code !== fields.safeErrorCode ||
    row.error_summary !== fields.errorSummary ||
    canonicalJson(row.code_diagnostics) !==
      canonicalJson(input.codeDiagnostics ?? null) ||
    executorMismatch;
  if (completionMismatch) {
    throw new NodeAttemptStateCorruptError();
  }
  if (receipt.completed_at === null) {
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
    (row.executor_failure_kind !== fields.executorOutcome.failureKind ||
      row.executor_error_kind !== fields.executorOutcome.errorKind ||
      row.executor_possibly_dispatched !==
        fields.executorOutcome.possiblyDispatched ||
      row.executor_retry_after_millis !==
        (fields.executorOutcome.minimumRetryDelayMillis ?? null) ||
      row.retry_decision === null)
  );
}
