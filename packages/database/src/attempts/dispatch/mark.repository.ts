import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
} from '../../schema/runs/execution.js';
import {
  connections,
  nodeAttemptConnectionDispatches,
} from '../../schema/connections.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { EXECUTION_SOURCE_SQL } from '../../runs/queries/execution/source.js';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

import { dispatchSchema } from '../validation/delivery.js';
import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from '../errors.js';
import type { NodeAttemptRunStore } from '../contract.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from '../transactions.repository.js';
import { isConnectionFenceCurrent } from '../../connections/runtime/dispatch.repository.js';

export async function markNodeAttemptDispatched(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['markDispatched']>[0],
): Promise<Readonly<{ dispatchedAt: Date }>> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof dispatchSchema>;
  try {
    input = dispatchSchema.parse(inputValue);
  } catch {
    throw new NodeAttemptStateCorruptError();
  }
  return withWorkspaceWriteClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      if (input.connectionFence !== undefined) {
        const current = await isConnectionFenceCurrent(
          client,
          input.lease.workspaceId,
          {
            connectionId: input.connectionFence.connectionId,
            providerKey: input.connectionFence.expectedProviderKey,
            authType: input.connectionFence.expectedAuthType,
            secretVersionId: input.connectionFence.secretVersionId,
          },
        );
        if (!current) throw new NodeAttemptConnectionFenceError();
      }
      const node = alias(nodeRuns, 'node');
      const run = alias(workflowRuns, 'run');
      const db = drizzle(client);
      const lease = input.lease;
      const lockedNode = await db
        .select({ providerDispatchBinding: node.providerDispatchBinding })
        .from(node)
        .innerJoin(
          run,
          and(
            eq(run.workspaceId, node.workspaceId),
            eq(run.id, node.workflowRunId),
          ),
        )
        .where(
          and(
            eq(node.workspaceId, lease.workspaceId),
            eq(node.id, lease.nodeRunId),
            eq(node.workflowRunId, lease.runId),
            eq(node.nodeId, lease.nodeId),
            eq(node.invocationKey, lease.invocationKey),
            eq(node.currentAttemptId, lease.attemptId),
            eq(run.workflowVersionId, lease.workflowVersionId),
          ),
        )
        .for('update', { of: node })
        .catch(rethrowQueryFailure);
      const existingBinding = lockedNode[0]?.providerDispatchBinding;
      if (existingBinding === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      const dispatchBindingChanged =
        input.providerDispatchBinding !== undefined &&
        existingBinding !== null &&
        existingBinding !== input.providerDispatchBinding;
      if (dispatchBindingChanged)
        throw new NodeAttemptDispatchBindingMismatchError();
      if (
        input.providerDispatchBinding !== undefined &&
        existingBinding === null
      )
        await db
          .update(nodeRuns)
          .set({
            providerDispatchBinding: input.providerDispatchBinding,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(nodeRuns.workspaceId, lease.workspaceId),
              eq(nodeRuns.id, lease.nodeRunId),
            ),
          )
          .catch(rethrowQueryFailure);
      const result = await db
        .update(nodeAttempts)
        .set({
          dispatchMarkedAt: sql`coalesce(${nodeAttempts.dispatchMarkedAt},clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(node)
        .innerJoin(
          run,
          and(
            eq(run.workspaceId, node.workspaceId),
            eq(run.id, node.workflowRunId),
          ),
        )
        .where(
          and(
            eq(nodeAttempts.workspaceId, lease.workspaceId),
            eq(nodeAttempts.id, lease.attemptId),
            eq(nodeAttempts.nodeRunId, lease.nodeRunId),
            eq(nodeAttempts.attemptNumber, lease.attemptNumber),
            eq(nodeAttempts.status, 'running'),
            eq(nodeAttempts.leaseOwner, lease.workerId),
            eq(nodeAttempts.fenceToken, lease.fenceToken),
            sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
            eq(node.workspaceId, nodeAttempts.workspaceId),
            eq(node.id, nodeAttempts.nodeRunId),
            eq(node.workflowRunId, lease.runId),
            eq(node.nodeId, lease.nodeId),
            eq(node.invocationKey, lease.invocationKey),
            eq(node.currentAttemptId, nodeAttempts.id),
            eq(run.workflowVersionId, lease.workflowVersionId),
          ),
        )
        .returning({
          dispatchedAt: sql<Date>`${nodeAttempts.dispatchMarkedAt}`.mapWith(
            nodeAttempts.dispatchMarkedAt,
          ),
        })
        .catch(rethrowQueryFailure);
      const dispatchedAt = result[0]?.dispatchedAt;
      if (dispatchedAt === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      await persistSlackDispatch(client, input);
      return Object.freeze({ dispatchedAt: new Date(dispatchedAt) });
    },
  );
}

async function persistSlackDispatch(
  client: PoolClient,
  input: z.output<typeof dispatchSchema>,
): Promise<void> {
  const db = drizzle(client);
  const lease = input.lease;
  // A Slack send remembers the secret and health revision it used, so a
  // run's later auth failure can mark exactly that connection state. Only
  // the published node's own bot-token connection is recorded.
  if (
    input.connectionFence?.expectedProviderKey === 'slack' &&
    input.connectionFence.expectedAuthType === 'slack_bot_token'
  ) {
    const published = await db
      .select({ executableJson: EXECUTION_SOURCE_SQL.executable_json })
      .from(EXECUTION_SOURCE_SQL)
      .where(
        and(
          eq(EXECUTION_SOURCE_SQL.workspace_id, lease.workspaceId),
          eq(EXECUTION_SOURCE_SQL.id, lease.workflowVersionId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (
      !publishesSlackBinding(
        published[0]?.executableJson,
        input.lease.nodeId,
        input.connectionFence.connectionId,
      )
    )
      throw new Error('Connection dispatch published binding mismatch');
    await db
      .insert(nodeAttemptConnectionDispatches)
      .select(
        db
          .select({
            workspaceId: connections.workspaceId,
            attemptId: sql<string>`${lease.attemptId}`.as('attempt_id'),
            connectionId: connections.id,
            providerKey: sql<string>`'slack'`.as('provider_key'),
            authType: sql<string>`'slack_bot_token'`.as('auth_type'),
            secretVersionId:
              sql<string>`${input.connectionFence.secretVersionId}`.as(
                'secret_version_id',
              ),
            healthRevision: connections.healthRevision,
            workerId: sql<string>`${lease.workerId}`.as('worker_id'),
            fenceToken: sql<number>`${lease.fenceToken}`.as('fence_token'),
          })
          .from(connections)
          .where(
            and(
              eq(connections.workspaceId, lease.workspaceId),
              eq(connections.id, input.connectionFence.connectionId),
            ),
          ),
      )
      .onConflictDoNothing({
        target: [
          nodeAttemptConnectionDispatches.workspaceId,
          nodeAttemptConnectionDispatches.attemptId,
        ],
      })
      .catch(rethrowQueryFailure);
  }
}

type PublishedNode = Readonly<{
  id?: unknown;
  definition?: Readonly<{ key?: unknown; version?: unknown }>;
  connectionRefs?: Readonly<Record<string, unknown>>;
  structured?: Readonly<{ body?: Readonly<{ nodes?: unknown }> }>;
}>;

/** Whether the published node sends with this Slack bot-token connection. */
function publishesSlackBinding(
  executable: unknown,
  nodeId: string,
  connectionId: string,
): boolean {
  const graph = (executable as { graph?: { nodes?: unknown } } | null)?.graph;
  const pending: unknown[] = [graph?.nodes];
  while (pending.length > 0) {
    const nodes = pending.pop();
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes as PublishedNode[]) {
      const matchesConnectionUse =
        node.id === nodeId &&
        node.definition?.key === 'slack.send_message' &&
        node.definition.version === 1 &&
        node.connectionRefs?.slack_bot_token === connectionId;
      if (matchesConnectionUse) return true;
      pending.push(node.structured?.body?.nodes);
    }
  }
  return false;
}
