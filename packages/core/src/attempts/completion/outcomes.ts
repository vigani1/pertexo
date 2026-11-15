import { isCurrentAttemptLease } from './attempt-completion.repository.js';
import { appendAttemptEvent } from '../../runs/queries/history/attempt-events.repository.js';
import type { PoolClient } from 'pg';

import {
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from '../node-attempt.errors.js';
import type {
  CompleteAttemptInput,
  CompleteNodeAttemptResult,
} from '../node-attempt.js';
import { completeReceipt } from './receipts.repository.js';
import { persistConnectionHealthObservation } from './connection-health.repository.js';
import type {
  SuspendedOutcome,
  CompletionReceiptRow,
  LockedAttemptRow,
  CompletionFields,
} from './attempt-completion.types.js';
import { duplicateCompletion } from './replay.js';
import {
  enqueueRunAdvance,
  saveAttemptCompletion,
  settleNodeRun,
  suspendNodeRun,
} from './outcomes.repository.js';

function completionFields(input: CompleteAttemptInput): CompletionFields {
  const outcome = input.outcome;
  switch (outcome.status) {
    case 'succeeded':
      return {
        durableStatus: 'succeeded',
        errorSummary: null,
        executorOutcome: undefined,
        safeErrorCode: null,
        suspendedOutcome: undefined,
      };
    case 'suspended':
      return {
        durableStatus: 'succeeded',
        errorSummary: null,
        executorOutcome: undefined,
        safeErrorCode: null,
        suspendedOutcome: outcome,
      };
    case 'executor_failure':
      return {
        durableStatus: 'failed',
        errorSummary: outcome.errorSummary ?? null,
        executorOutcome: outcome,
        safeErrorCode: outcome.safeErrorCode,
        suspendedOutcome: undefined,
      };
    case 'canceled':
    case 'failed':
    case 'outcome_unknown':
    case 'timed_out':
      return {
        durableStatus: outcome.status,
        errorSummary: outcome.errorSummary ?? null,
        executorOutcome: undefined,
        safeErrorCode: outcome.safeErrorCode,
        suspendedOutcome: undefined,
      };
  }
}

function assertActiveLease(
  input: CompleteAttemptInput,
  row: LockedAttemptRow,
  receipt: CompletionReceiptRow,
): void {
  if (
    !isCurrentAttemptLease(input.lease, row) ||
    receipt.completedAt !== null
  ) {
    throw new NodeAttemptReconciliationRequiredError();
  }
}

async function commitAndReceipt(
  client: PoolClient,
  input: CompleteAttemptInput,
): Promise<CompleteNodeAttemptResult> {
  const outboxEventId = await enqueueRunAdvance(client, input);
  await completeReceipt(client, input.lease.workspaceId, input.lease.delivery);
  return Object.freeze({ kind: 'committed' as const, outboxEventId });
}

async function commitSuspension(
  client: PoolClient,
  input: CompleteAttemptInput,
  outcome: SuspendedOutcome,
  serializedOutput: string | null,
): Promise<CompleteNodeAttemptResult> {
  const resumeAt = await suspendNodeRun(
    client,
    input,
    outcome,
    serializedOutput,
  );
  if (resumeAt === undefined) throw new NodeAttemptStateCorruptError();
  await appendAttemptEvent(client, {
    workspaceId: input.lease.workspaceId,
    runId: input.lease.runId,
    type: 'node.waiting',
    payload: {
      nodeRunId: input.lease.nodeRunId,
      attemptId: input.lease.attemptId,
      invocationKey: input.lease.invocationKey,
      nodeId: input.lease.nodeId,
      attemptNumber: input.lease.attemptNumber,
      dueAt: resumeAt.toISOString(),
      waitKind: 'node_wait',
    },
  });
  return commitAndReceipt(client, input);
}

async function commitTerminal(
  client: PoolClient,
  input: CompleteAttemptInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<CompleteNodeAttemptResult> {
  const settled = await settleNodeRun(client, input, serializedOutput, fields);
  if (!settled) throw new NodeAttemptStateCorruptError();
  await appendAttemptEvent(client, {
    workspaceId: input.lease.workspaceId,
    runId: input.lease.runId,
    type: `node.${fields.durableStatus}`,
    payload: {
      nodeRunId: input.lease.nodeRunId,
      attemptId: input.lease.attemptId,
      invocationKey: input.lease.invocationKey,
      nodeId: input.lease.nodeId,
      attemptNumber: input.lease.attemptNumber,
      ...(fields.safeErrorCode === null
        ? {}
        : { safeErrorCode: fields.safeErrorCode }),
    },
  });
  return commitAndReceipt(client, input);
}

export async function applyNodeAttemptCompletion(
  client: PoolClient,
  input: CompleteAttemptInput,
  {
    row,
    receipt,
    serializedOutput,
    controlActive,
  }: Readonly<{
    row: LockedAttemptRow;
    receipt: CompletionReceiptRow;
    serializedOutput: string | null;
    controlActive: boolean;
  }>,
): Promise<CompleteNodeAttemptResult> {
  const fields = completionFields(input);
  const duplicate = await duplicateCompletion(client, input, {
    row,
    receipt,
    serializedOutput,
    fields,
  });
  if (duplicate !== undefined) return duplicate;
  if (fields.suspendedOutcome !== undefined && controlActive)
    throw new NodeAttemptReconciliationRequiredError();
  assertActiveLease(input, row, receipt);
  await saveAttemptCompletion(client, input, serializedOutput, fields);
  await persistConnectionHealthObservation(client, input);
  if (fields.executorOutcome !== undefined) {
    return commitAndReceipt(client, input);
  }
  if (fields.suspendedOutcome !== undefined)
    return commitSuspension(
      client,
      input,
      fields.suspendedOutcome,
      serializedOutput,
    );
  return commitTerminal(client, input, serializedOutput, fields);
}
