import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool } from 'pg';
import type { NodeAttemptRunStore } from '../contract.js';
import { withWorkspaceWriteClient } from '../transactions.repository.js';
import { serializeStoredExecutionValue } from '../../platform/stored-execution-value.js';

type RecordInputRequest = Parameters<
  NonNullable<NodeAttemptRunStore['recordInput']>
>[0];

/**
 * Writes an attempt's resolved input onto its node run while the caller still
 * holds the attempt, under the heartbeat's own predicate (ADR 052). Anything
 * that stops it, an input over the inline bound, a lost lease or a failed
 * write, records nothing: the input is diagnostic and never changes the
 * attempt.
 */
export async function recordNodeAttemptInput(
  pool: Pool,
  request: RecordInputRequest,
): Promise<Readonly<{ recorded: boolean }>> {
  if (request.signal.aborted) return { recorded: false };
  const { lease, signal } = request;
  let stored: string;
  try {
    stored = serializeStoredExecutionValue({
      kind: 'inline',
      value: request.input,
    });
  } catch {
    return { recorded: false };
  }
  try {
    return await withWorkspaceWriteClient(
      pool,
      lease.workspaceId,
      signal,
      async (client) => {
        const result = await drizzle(client)
          .update(nodeRuns)
          .set({
            inputRef: sql`${stored}::json`,
            updatedAt: sql`clock_timestamp()`,
          })
          .from(nodeAttempts)
          .innerJoin(
            workflowRuns,
            and(
              eq(workflowRuns.workspaceId, nodeAttempts.workspaceId),
              eq(workflowRuns.id, lease.runId),
            ),
          )
          .where(
            and(
              eq(nodeRuns.workspaceId, lease.workspaceId),
              eq(nodeRuns.id, lease.nodeRunId),
              eq(nodeRuns.currentAttemptId, lease.attemptId),
              eq(nodeRuns.workflowRunId, lease.runId),
              eq(nodeRuns.nodeId, lease.nodeId),
              eq(nodeRuns.invocationKey, lease.invocationKey),
              eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
              eq(nodeAttempts.id, lease.attemptId),
              eq(nodeAttempts.nodeRunId, nodeRuns.id),
              eq(nodeAttempts.attemptNumber, lease.attemptNumber),
              eq(nodeAttempts.status, 'running'),
              eq(nodeAttempts.leaseOwner, lease.workerId),
              eq(nodeAttempts.fenceToken, lease.fenceToken),
              sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
              eq(workflowRuns.workflowVersionId, lease.workflowVersionId),
            ),
          )
          .returning({ id: nodeRuns.id })
          .catch(rethrowQueryFailure);
        return { recorded: result.length === 1 };
      },
    );
  } catch {
    return { recorded: false };
  }
}
