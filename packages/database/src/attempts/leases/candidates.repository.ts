import { and, eq, exists, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { NodeAttemptStateCorruptError } from '../errors.js';
import type { claimDeliverySchema } from '../validation/delivery.js';

export async function lockClaimCandidate(
  client: PoolClient,
  input: z.output<typeof claimDeliverySchema>,
) {
  const db = drizzle(client);
  const candidate = await db
    .select({ runId: nodeRuns.workflowRunId })
    .from(nodeAttempts)
    .innerJoin(
      nodeRuns,
      and(
        eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
        eq(nodeRuns.id, nodeAttempts.nodeRunId),
      ),
    )
    .where(
      and(
        eq(nodeAttempts.workspaceId, input.workspaceId),
        eq(nodeAttempts.id, input.attemptId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (candidate[0]?.runId !== input.runId)
    throw new NodeAttemptStateCorruptError();
  const run = await db
    .select({ workflowVersionId: workflowRuns.workflowVersionId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, input.workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const runRow = run[0];
  if (runRow === undefined) throw new NodeAttemptStateCorruptError();
  const attempt = alias(nodeAttempts, 'attempt');
  const node = alias(nodeRuns, 'node');
  const prior = alias(nodeAttempts, 'prior');
  const unresolved = db
    .select({ one: sql`1` })
    .from(prior)
    .where(
      and(
        eq(prior.workspaceId, attempt.workspaceId),
        eq(prior.nodeRunId, attempt.nodeRunId),
        lt(prior.attemptNumber, attempt.attemptNumber),
        eq(prior.executorPossiblyDispatched, true),
        eq(prior.retryDecision, 'retry'),
      ),
    );
  const locked = await db
    .select({
      attemptNumber: attempt.attemptNumber,
      admissionKind: attempt.admissionKind,
      attemptStatus: attempt.status,
      leaseExpiresAt: attempt.leaseExpiresAt,
      leaseValid: sql<
        boolean | null
      >`${attempt.leaseExpiresAt}>clock_timestamp()`,
      invocationKey: node.invocationKey,
      nodeId: node.nodeId,
      branchContext: node.branchContext,
      nodeStatus: node.status,
      sideEffectClass: attempt.sideEffectClass,
      providerIdempotencyKey: attempt.providerIdempotencyKey,
      providerDispatchBinding: node.providerDispatchBinding,
      providerDispatchUnresolved: sql<boolean>`(${attempt.dispatchMarkedAt} is not null or ${exists(unresolved)})`,
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
        eq(attempt.workspaceId, input.workspaceId),
        eq(attempt.id, input.attemptId),
        eq(attempt.nodeRunId, input.nodeRunId),
        eq(node.workflowRunId, input.runId),
        eq(node.currentAttemptId, attempt.id),
        eq(node.currentAttemptNumber, attempt.attemptNumber),
      ),
    )
    .for('update', { of: [node, attempt] })
    .catch(rethrowQueryFailure);
  const row = locked[0];
  if (row === undefined) throw new NodeAttemptStateCorruptError();
  return { row, runRow };
}
