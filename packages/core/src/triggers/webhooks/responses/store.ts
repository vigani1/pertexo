import {
  withTenantScopedClient,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { and, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  webhookRunResponses as responses,
  workflowRuns,
  nodeAttempts,
  nodeRuns,
} from '@pertexo/database/schema';
import type { Pool, PoolClient } from 'pg';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { DatabaseConfig } from '@pertexo/database/platform';
import { NodeAttemptReconciliationRequiredError } from '../../../attempts/errors.js';
import type { NodeWebhookResponseReceipt } from '@pertexo/node-sdk';
import type { WriteWebhookResponse } from './contract.js';

export type WebhookResponseStore = ReturnType<
  typeof createWebhookResponseStore
>;

/** The worker's step answering a waiting sender: fenced by its attempt, not by a member. */

export function createWebhookResponseStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return {
    respond: (input: WriteWebhookResponse) =>
      writeWebhookResponse(lease.pool, input),
    close: () => lease.close(),
  };
}
function writeWebhookResponse(
  pool: Pool,
  input: WriteWebhookResponse,
): Promise<NodeWebhookResponseReceipt> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      // Run → node/attempt → response is also completion's lock order.
      const db = drizzle(client);
      const run = await db
        .select({ status: workflowRuns.status })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workspaceId, input.workspaceId),
            eq(workflowRuns.id, input.runId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if (
        run[0] === undefined ||
        !['running', 'waiting'].includes(run[0].status)
      )
        throw new NodeAttemptReconciliationRequiredError();
      const attemptRecord = alias(nodeAttempts, 'attempt');
      const node = alias(nodeRuns, 'node');
      const attempt = await db
        .select({ id: attemptRecord.id })
        .from(attemptRecord)
        .innerJoin(
          node,
          and(
            eq(node.workspaceId, attemptRecord.workspaceId),
            eq(node.id, attemptRecord.nodeRunId),
          ),
        )
        .where(
          and(
            eq(attemptRecord.workspaceId, input.workspaceId),
            eq(attemptRecord.id, input.attemptId),
            eq(attemptRecord.nodeRunId, input.nodeRunId),
            eq(attemptRecord.attemptNumber, input.attemptNumber),
            eq(node.workflowRunId, input.runId),
            eq(node.nodeId, input.nodeId),
            eq(node.invocationKey, input.invocationKey),
          ),
        )
        .for('update', { of: [node, attemptRecord] })
        .catch(rethrowQueryFailure);
      if (attempt[0] === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      const current = await db
        .select({
          node_run_id: responses.nodeRunId,
          invocation_key: responses.invocationKey,
          status_code: responses.statusCode,
        })
        .from(responses)
        .where(
          and(
            eq(responses.workspaceId, input.workspaceId),
            eq(responses.runId, input.runId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      // Evaluate time after every lock wait, not in the locking SELECT's snapshot.
      if (!(await responseAttemptIsLive(client, input)))
        throw new NodeAttemptReconciliationRequiredError();
      const row = current[0];
      if (row === undefined)
        return { outcome: 'not_waiting', statusCode: null };
      if (row.status_code !== null)
        return {
          outcome:
            row.node_run_id === input.nodeRunId &&
            row.invocation_key === input.invocationKey
              ? 'responded'
              : 'already_responded',
          statusCode: row.status_code,
        };
      const response = input.response;
      const liveAttempt = db
        .select({ one: sql`1` })
        .from(nodeAttempts)
        .where(
          and(
            eq(nodeAttempts.workspaceId, input.workspaceId),
            eq(nodeAttempts.id, input.attemptId),
            sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
          ),
        );
      const liveRun = db
        .select({ one: sql`1` })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workspaceId, input.workspaceId),
            eq(workflowRuns.id, input.runId),
            sql`(${workflowRuns.deadlineAt} is null or ${workflowRuns.deadlineAt}>clock_timestamp())`,
          ),
        );
      const written = await db
        .update(responses)
        .set({
          statusCode: response.statusCode,
          contentType: response.contentType,
          headers: response.headers,
          body: response.body,
          nodeRunId: input.nodeRunId,
          invocationKey: input.invocationKey,
          respondedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(responses.workspaceId, input.workspaceId),
            eq(responses.runId, input.runId),
            exists(liveAttempt),
            exists(liveRun),
          ),
        )
        .returning({ id: responses.runId })
        .catch(rethrowQueryFailure);
      if (written.length !== 1)
        throw new NodeAttemptReconciliationRequiredError();
      return { outcome: 'responded', statusCode: response.statusCode };
    },
    { signal: input.signal },
  );
}

async function responseAttemptIsLive(
  client: PoolClient,
  input: WriteWebhookResponse,
): Promise<boolean> {
  const db = drizzle(client);
  const fence = await db
    .select({
      valid: sql<
        boolean | null
      >`(${nodeAttempts.status}='running' and ${nodeAttempts.leaseOwner}=${input.workerId}
        and ${nodeAttempts.fenceToken}=${input.fenceToken} and ${nodeAttempts.leaseExpiresAt}>clock_timestamp() and ${nodeAttempts.dispatchMarkedAt} is not null
        and ${nodeRuns.currentAttemptId}=${nodeAttempts.id} and ${workflowRuns.cancelRequestedAt} is null
        and (${workflowRuns.deadlineAt} is null or ${workflowRuns.deadlineAt}>clock_timestamp()))`,
    })
    .from(nodeAttempts)
    .innerJoin(
      nodeRuns,
      and(
        eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
        eq(nodeRuns.id, nodeAttempts.nodeRunId),
      ),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, nodeRuns.workspaceId),
        eq(workflowRuns.id, nodeRuns.workflowRunId),
      ),
    )
    .where(
      and(
        eq(nodeAttempts.workspaceId, input.workspaceId),
        eq(nodeAttempts.id, input.attemptId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .catch(rethrowQueryFailure);

  return fence[0]?.valid ?? false;
}
