import { and, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
  runEvents,
} from '../../schema/runs/execution.js';
import { inboxReceipts } from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { CompletionInput } from './contract.js';
import { nodeAttemptConsumerName } from './receipts.repository.js';
import { runAbortState } from '../queries/control.js';

export async function lockCompletionReceipt(
  client: PoolClient,
  input: CompletionInput,
) {
  return drizzle(client)
    .select({
      completedAt: inboxReceipts.completedAt,
      payloadChecksum: inboxReceipts.payloadChecksum,
    })
    .from(inboxReceipts)
    .where(
      and(
        eq(inboxReceipts.consumerName, nodeAttemptConsumerName),
        eq(inboxReceipts.messageId, input.lease.delivery.outboxEventId),
        eq(inboxReceipts.workspaceId, input.lease.workspaceId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}

export async function lockCompletionRun(
  client: PoolClient,
  input: CompletionInput,
) {
  return drizzle(client)
    .select({ abortRequested: runAbortState.abortRequested })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, input.lease.workspaceId),
        eq(workflowRuns.id, input.lease.runId),
        eq(workflowRuns.workflowVersionId, input.lease.workflowVersionId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}

export async function lockCompletionAttempt(
  client: PoolClient,
  { lease }: CompletionInput,
) {
  const db = drizzle(client);
  const attempt = alias(nodeAttempts, 'attempt');
  const node = alias(nodeRuns, 'node');
  const suspension = db
    .select({ one: sql`1` })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, attempt.workspaceId),
        eq(runEvents.workflowRunId, node.workflowRunId),
        eq(runEvents.type, 'node.waiting'),
        sql`${runEvents.payload}->>'attemptId'=${attempt.id}::text`,
      ),
    );
  return db
    .select({
      attemptStatus: attempt.status,
      fenceToken: attempt.fenceToken,
      leaseOwner: attempt.leaseOwner,
      leaseExpiresAt: attempt.leaseExpiresAt,
      leaseValid: sql<
        boolean | null
      >`(${attempt.leaseExpiresAt}>clock_timestamp())`,
      outputRef: attempt.outputRef,
      safeErrorCode: attempt.safeErrorCode,
      errorSummary: attempt.errorSummary,
      codeDiagnostics: attempt.codeDiagnostics,
      executorFailureKind: attempt.executorFailureKind,
      executorRetryAfterMillis: attempt.executorRetryAfterMillis,
      executorErrorKind: attempt.executorErrorKind,
      executorPossiblyDispatched: attempt.executorPossiblyDispatched,
      retryDecision: attempt.retryDecision,
      nodeStatus: node.status,
      waitKind: node.waitKind,
      currentAttempt: sql<
        boolean | null
      >`(${node.currentAttemptId}=${attempt.id})`,
      suspensionRecorded: sql<boolean>`${exists(suspension)}`,
    })
    .from(attempt)
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, attempt.workspaceId),
        eq(node.id, attempt.nodeRunId),
      ),
    )
    .where(
      and(
        eq(attempt.workspaceId, lease.workspaceId),
        eq(attempt.id, lease.attemptId),
        eq(attempt.nodeRunId, lease.nodeRunId),
        eq(attempt.attemptNumber, lease.attemptNumber),
        eq(node.workflowRunId, lease.runId),
        eq(node.nodeId, lease.nodeId),
        eq(node.invocationKey, lease.invocationKey),
      ),
    )
    .for('update', { of: [node, attempt] })
    .catch(rethrowQueryFailure);
}
