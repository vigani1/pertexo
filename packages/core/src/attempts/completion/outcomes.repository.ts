import { storedAttemptDiagnostics } from '@pertexo/node-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns, nodeAttempts, outboxEvents } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import { canonicalJson } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import { serializeStoredExecutionJsonValue } from '../../shared/stored-execution.js';
import type { CompleteAttemptInput } from '../node-attempt.js';
import type {
  CompletionFields,
  SuspendedOutcome,
} from './attempt-completion.types.js';

export async function saveAttemptCompletion(
  client: PoolClient,
  input: CompleteAttemptInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<void> {
  const diagnostics = storedAttemptDiagnostics(input);
  await drizzle(client)
    .update(nodeAttempts)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      ...attemptOutcomeFields(fields, serializedOutput),
      codeDiagnostics:
        diagnostics === null ? null : sql`${canonicalJson(diagnostics)}::jsonb`,
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

export function attemptOutcomeFields(
  fields: CompletionFields,
  serializedOutput: string | null,
  decision = 'pending',
) {
  return {
    status: fields.durableStatus,
    outputRef: sql`${serializedOutput}::json`,
    safeErrorCode: fields.safeErrorCode,
    errorSummary: fields.errorSummary,
    executorFailureKind: fields.executorOutcome?.failureKind ?? null,
    executorErrorKind: fields.executorOutcome?.errorKind ?? null,
    executorPossiblyDispatched:
      fields.executorOutcome?.possiblyDispatched ?? null,
    retryDecision: fields.executorOutcome === undefined ? null : decision,
    executorRetryAfterMillis:
      fields.executorOutcome?.minimumRetryDelayMillis ?? null,
  };
}

/** Asks the coordinator to advance the run, in this transaction. */
export async function enqueueRunAdvance(
  client: PoolClient,
  input: CompleteAttemptInput,
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

/** When the waiting node resumes; undefined when it was no longer running. */
export async function suspendNodeRun(
  client: PoolClient,
  input: CompleteAttemptInput,
  outcome: SuspendedOutcome,
  serializedOutput: string | null,
): Promise<Date | undefined> {
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
  return suspended[0]?.resumeAt;
}

/** Whether the node run still belonged to this attempt and is now settled. */
export async function settleNodeRun(
  client: PoolClient,
  input: CompleteAttemptInput,
  serializedOutput: string | null,
  fields: CompletionFields,
): Promise<boolean> {
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
  return node.length === 1;
}
