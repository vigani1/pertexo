import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns, nodeAttempts, outboxEvents } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  canonicalOutboxPayloadChecksum,
  serializeStoredExecutionJsonValue,
} from '@pertexo/database/primitives';
import { appendAttemptEvent } from '../events.repository.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { generatePersistedId } from '@pertexo/database/platform';
import type { PoolClient } from 'pg';

import {
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from '../errors.js';
import type { CompleteNodeAttemptResult } from '../contract.js';
import { completeReceipt } from './receipts.repository.js';
import { persistConnectionHealthObservation } from './connection-health.repository.js';
import type {
  CompletionInput,
  SuspendedOutcome,
  CompletionReceiptRow,
  LockedAttemptRow,
  CompletionFields,
} from './contract.js';
import { duplicateCompletion } from './replay.js';

function completionFields(input: CompletionInput): CompletionFields {
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
  input: CompletionInput,
  row: LockedAttemptRow,
  receipt: CompletionReceiptRow,
): void {
  const staleAttemptLease =
    row.attemptStatus !== 'running' ||
    !row.currentAttempt ||
    row.nodeStatus !== 'running' ||
    row.leaseOwner !== input.lease.workerId ||
    row.fenceToken !== input.lease.fenceToken ||
    row.leaseExpiresAt === null ||
    !row.leaseValid ||
    receipt.completedAt !== null;
  if (staleAttemptLease) {
    throw new NodeAttemptReconciliationRequiredError();
  }
}

async function updateAttempt(
  client: PoolClient,
  input: CompletionInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<void> {
  await drizzle(client)
    .update(nodeAttempts)
    .set({
      status: fields.durableStatus,
      leaseOwner: null,
      leaseExpiresAt: null,
      outputRef: sql`${serializedOutput}::json`,
      safeErrorCode: fields.safeErrorCode,
      errorSummary: fields.errorSummary,
      executorFailureKind: fields.executorOutcome?.failureKind ?? null,
      executorErrorKind: fields.executorOutcome?.errorKind ?? null,
      executorPossiblyDispatched:
        fields.executorOutcome?.possiblyDispatched ?? null,
      retryDecision: fields.executorOutcome === undefined ? null : 'pending',
      codeDiagnostics:
        input.codeDiagnostics === undefined
          ? null
          : sql`${canonicalJson(input.codeDiagnostics)}::jsonb`,
      executorRetryAfterMillis:
        fields.executorOutcome?.minimumRetryDelayMillis ?? null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeAttempts.workspaceId, input.lease.workspaceId),
        eq(nodeAttempts.id, input.lease.attemptId),
      ),
    )
    .catch(rethrowQueryFailure);
}

async function enqueueAdvance(
  client: PoolClient,
  input: CompletionInput,
): Promise<string> {
  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId: input.lease.workspaceId,
    runId: input.lease.runId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.lease.workspaceId,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: input.lease.runId,
      payload: sql`${serializeStoredExecutionJsonValue(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
  return outboxEventId;
}

async function commitAndReceipt(
  client: PoolClient,
  input: CompletionInput,
): Promise<CompleteNodeAttemptResult> {
  const outboxEventId = await enqueueAdvance(client, input);
  await completeReceipt(client, input.lease.workspaceId, input.lease.delivery);
  return Object.freeze({ kind: 'committed' as const, outboxEventId });
}

async function commitSuspension(
  client: PoolClient,
  input: CompletionInput,
  outcome: SuspendedOutcome,
  serializedOutput: string | null,
): Promise<CompleteNodeAttemptResult> {
  const suspended = await drizzle(client)
    .update(nodeRuns)
    .set({
      status: 'waiting',
      outputRef: sql`${serializedOutput}::json`,
      waitKind: 'node_wait',
      resumeAt: sql`clock_timestamp()+make_interval(secs=>${outcome.durationSeconds})`,
      retryDueAt: null,
      dueWakeupAt: null,
      safeErrorCode: null,
      completedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, input.lease.workspaceId),
        eq(nodeRuns.id, input.lease.nodeRunId),
        eq(nodeRuns.currentAttemptId, input.lease.attemptId),
        eq(nodeRuns.status, 'running'),
      ),
    )
    .returning({
      resumeAt: sql<Date>`${nodeRuns.resumeAt}`.mapWith(nodeRuns.resumeAt),
    })
    .catch(rethrowQueryFailure);
  const resumeAt = suspended[0]?.resumeAt;
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
  input: CompletionInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<CompleteNodeAttemptResult> {
  const node = await drizzle(client)
    .update(nodeRuns)
    .set({
      status: fields.durableStatus,
      outputRef: sql`${serializedOutput}::json`,
      safeErrorCode: fields.safeErrorCode,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, input.lease.workspaceId),
        eq(nodeRuns.id, input.lease.nodeRunId),
        eq(nodeRuns.currentAttemptId, input.lease.attemptId),
      ),
    )
    .returning({ id: nodeRuns.id })
    .catch(rethrowQueryFailure);
  if (node.length !== 1) throw new NodeAttemptStateCorruptError();
  await appendAttemptEvent(client, {
    workspaceId: input.lease.workspaceId,
    runId: input.lease.runId,
    type: `node.${input.outcome.status}`,
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
  input: CompletionInput,
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
  await updateAttempt(client, input, serializedOutput, fields);
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
