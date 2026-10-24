import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { nodeRuns, workflowRuns } from '../../../schema/runs/execution.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { callbackScopeHash } from './identity.repository.js';
import {
  readPendingTaskAllowance,
  hasPendingTaskCapacity,
} from '../lifecycle/allowance.queries.js';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import {
  lockCapabilityExecution,
  assertCapabilityExecution,
} from '../../../attempts/dispatch/fence.repository.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import {
  CallbackCapacityError,
  type CallbackStore,
  type PreparedCallback,
} from './contract.js';
export async function prepareCallbacks(
  client: PoolClient,
  input: Parameters<CallbackStore['prepare']>[0],
): Promise<readonly PreparedCallback[]> {
  await lockCapabilityExecution(client, input);
  await assertCapabilityExecution(client, input);
  if (input.previewRunId !== undefined)
    throw new Error('Previews cannot issue live callback URLs.');
  const db = drizzle(client),
    n = nodeRuns,
    r = workflowRuns,
    t = pendingRunTasks;
  const [owner] = await db
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
  if (owner === undefined)
    throw new Error('The callback execution scope is unavailable.');
  const iteration = owner.branch_context.iterationPath ?? [];
  const scopeHash = callbackScopeHash(iteration);
  await db
    .execute(
      sql`select app.lock_workspace_execution_counter(${input.workspaceId})`,
    )
    .catch(rethrowQueryFailure);
  const allowance = await readPendingTaskAllowance(client, input.workspaceId);
  let count = allowance.count;
  const result: PreparedCallback[] = [];
  for (const target of input.targets) {
    // A non-null callback node identity selects the callback-kind CHECK's complete key pair.
    const [found] = await db
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
          eq(t.callbackNodeId, target.nodeId),
          eq(t.callbackScopeHash, scopeHash),
        ),
      )
      .catch(rethrowQueryFailure);
    const identity = {
      id: found?.id ?? generatePersistedId(),
      workspaceId: input.workspaceId,
      runId: input.runId,
      nodeId: target.nodeId,
      scopeHash,
    };
    if (found !== undefined) {
      result.push({
        ...identity,
        id: found.id,
        keyVersion: found.callback_key_version,
        tokenHash: found.callback_token_hash,
        config: callbackWaitConfigSchema.parse(found.config),
      });
      continue;
    }
    if (!hasPendingTaskCapacity({ ...allowance, count }))
      throw new CallbackCapacityError();
    count++;
    const id = identity.id,
      tokenHash = input.tokenHash(identity);
    await persistPreparedCallback(client, {
      input,
      target,
      iteration,
      scopeHash,
      id,
      tokenHash,
    });
    result.push({
      ...identity,
      id,
      keyVersion: input.keyVersion,
      tokenHash,
      config: target.config,
    });
  }
  await assertCapabilityExecution(client, input);
  return result;
}

function persistPreparedCallback(
  client: PoolClient,
  options: Readonly<{
    input: Parameters<CallbackStore['prepare']>[0];
    target: Parameters<CallbackStore['prepare']>[0]['targets'][number];
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
