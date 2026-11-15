import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  nodeRuns,
  workflowRuns,
  pendingRunTasks,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { CallbackPreparation } from './callback.types.js';

/** The calling node's branch context, or undefined when it isn't in this run. */
export async function readCallbackOwner(
  client: PoolClient,
  input: CallbackPreparation,
) {
  const n = nodeRuns,
    r = workflowRuns;
  const [owner] = await drizzle(client)
    .select({
      branch_context: sql<
        Readonly<{ iterationPath?: unknown }>
      >`${n.branchContext}`,
    })
    .from(n)
    .innerJoin(
      r,
      and(eq(r.workspaceId, n.workspaceId), eq(r.id, n.workflowRunId)),
    )
    .where(
      and(
        eq(n.workspaceId, input.workspaceId),
        eq(n.id, input.nodeRunId),
        eq(r.id, input.runId),
      ),
    )
    .catch(rethrowQueryFailure);
  return owner;
}

export async function findPreparedCallback(
  client: PoolClient,
  input: CallbackPreparation,
  nodeId: string,
  scopeHash: string,
) {
  const t = pendingRunTasks;
  // A non-null callback node identity selects the callback-kind CHECK's complete key pair.
  const [found] = await drizzle(client)
    .select({
      id: t.id,
      callback_key_version: sql<string>`${t.callbackKeyVersion}`,
      callback_token_hash: sql<string>`${t.callbackTokenHash}`,
      config: t.config,
    })
    .from(t)
    .where(
      and(
        eq(t.workspaceId, input.workspaceId),
        eq(t.runId, input.runId),
        eq(t.callbackNodeId, nodeId),
        eq(t.callbackScopeHash, scopeHash),
      ),
    )
    .catch(rethrowQueryFailure);
  return found;
}

export function persistPreparedCallback(
  client: PoolClient,
  options: Readonly<{
    input: CallbackPreparation;
    target: CallbackPreparation['targets'][number];
    iteration: unknown;
    scopeHash: string;
    id: string;
    tokenHash: string;
  }>,
) {
  const { input, target, iteration, scopeHash, id, tokenHash } = options;
  const db = drizzle(client),
    run = workflowRuns;
  const declaration = db
    .select({
      id: sql<string>`${id}::uuid`.as('id'),
      workspaceId: sql<string>`${input.workspaceId}::uuid`.as('workspace_id'),
      runId: sql<string>`${input.runId}::uuid`.as('run_id'),
      workflowVersionId: run.workflowVersionId,
      nodeRunId: sql`null`.as('node_run_id'),
      callbackNodeId: sql<string>`${target.nodeId}`.as('callback_node_id'),
      callbackScope: sql`${JSON.stringify(iteration)}::jsonb`.as(
        'callback_scope',
      ),
      callbackScopeHash: sql<string>`${scopeHash}`.as('callback_scope_hash'),
      callbackTokenHash: sql<string>`${tokenHash}`.as('callback_token_hash'),
      callbackKeyVersion: sql<string>`${input.keyVersion}`.as(
        'callback_key_version',
      ),
      openedAt: sql`null`.as('opened_at'),
      invocationKey:
        sql<string>`${'callback:' + target.nodeId + ':' + scopeHash}`.as(
          'invocation_key',
        ),
      kind: sql<string>`'callback'`.as('kind'),
      config: sql`${JSON.stringify(target.config)}::jsonb`.as('config'),
      context: sql`'{}'::jsonb`.as('context'),
      status: sql<string>`'prepared'`.as('status'),
      outputRef: sql`null`.as('output_ref'),
      decidedBy: sql`null`.as('decided_by'),
      createdAt: sql<Date>`clock_timestamp()`.as('created_at'),
      expiresAt: sql`null`.as('expires_at'),
      completedAt: sql`null`.as('completed_at'),
      consumedAt: sql`null`.as('consumed_at'),
    })
    .from(run)
    .where(
      and(eq(run.workspaceId, input.workspaceId), eq(run.id, input.runId)),
    );
  return db
    .insert(pendingRunTasks)
    .select(declaration)
    .catch(rethrowQueryFailure);
}
