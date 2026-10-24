import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { workspaces } from '../../../schema/foundation.js';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { resolveCallback, callbackKeysInUse } from './records.queries.js';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import { withWorkspaceWriteClient } from '../../../attempts/transactions.repository.js';
import { serializeStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import { wakeWorkflowRun } from '../../calls/wakeup.repository.js';
import { wakeTaskAncestors } from '../responses/respond.repository.js';
import { prepareCallbacks } from './prepare.repository.js';
import { CallbackResponseError } from './errors.js';
import type { CallbackStore, PreparedCallback } from './contract.js';

type Row = Awaited<ReturnType<typeof resolveCallback>>[number];
function project(row: Row): PreparedCallback {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    nodeId: row.callback_node_id,
    scopeHash: row.callback_scope_hash,
    tokenHash: row.callback_token_hash,
    keyVersion: row.callback_key_version,
    config: callbackWaitConfigSchema.parse(row.config),
  };
}
export function createCallbackStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): CallbackStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    prepare: (input) =>
      withWorkspaceWriteClient(
        lease.pool,
        input.workspaceId,
        input.signal,
        (client) => prepareCallbacks(client, input),
      ),
    resolve: async (tokenHash, signal) => {
      signal.throwIfAborted();
      const result = await resolveCallback(lease.pool, tokenHash);
      signal.throwIfAborted();
      return result[0] === undefined
        ? null
        : {
            ...project(result[0]),
            databaseTime: result[0].database_time,
          };
    },
    keysInUse: async function* (signal) {
      let after: string | null = null;
      do {
        signal.throwIfAborted();
        const page: Awaited<ReturnType<typeof callbackKeysInUse>> =
          await callbackKeysInUse(lease.pool, after);
        if (page.length === 0) return;
        for (const row of page) yield row;
        after = page.at(-1)?.keyVersion ?? null;
      } while (after !== null);
    },
    respond: (input) =>
      withWorkspaceWriteClient(
        lease.pool,
        input.callback.workspaceId,
        input.signal,
        (client) => respondCallback(client, input),
      ),
  };
}

async function respondCallback(
  client: PoolClient,
  input: Parameters<CallbackStore['respond']>[0],
) {
  const identity = input.callback;
  const db = drizzle(client),
    w = workspaces,
    r = workflowRuns,
    t = pendingRunTasks;
  const [workspace] = await db
    .select({ status: w.status })
    .from(w)
    .where(eq(w.id, identity.workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  const [owner] = await db
    .select({
      status: r.status,
      closed: sql<boolean>`${r.cancelRequestedAt} is not null or (${r.deadlineAt} is not null and ${r.deadlineAt}<=clock_timestamp())`,
    })
    .from(r)
    .where(
      and(eq(r.workspaceId, identity.workspaceId), eq(r.id, identity.runId)),
    )
    .for('no key update')
    .catch(rethrowQueryFailure);
  const [task] = await db
    .select({
      status: t.status,
      expired: sql<boolean>`${t.expiresAt} is not null and ${t.expiresAt}<=clock_timestamp()`,
      node_run_id: t.nodeRunId,
      invocation_key: t.invocationKey,
      consumed_at: t.consumedAt,
    })
    .from(t)
    .where(
      and(
        eq(t.workspaceId, identity.workspaceId),
        eq(t.runId, identity.runId),
        eq(t.id, identity.id),
        eq(t.kind, 'callback'),
        eq(t.callbackTokenHash, identity.tokenHash),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const callbackUnavailable =
    workspace?.status !== 'active' ||
    owner === undefined ||
    owner.closed ||
    !['queued', 'running', 'waiting'].includes(owner.status) ||
    task === undefined ||
    task.expired ||
    task.consumed_at !== null ||
    ['expired', 'refused', 'canceled'].includes(task.status);
  if (callbackUnavailable) throw new CallbackResponseError('closed');
  if (task.status === 'submitted') throw new CallbackResponseError('resolved');
  // Normalize escapes and enforce the value bounds before credential redaction.
  const output = input.redactOutput(
    serializeStoredExecutionValue({
      kind: 'inline',
      value: input.output,
    }),
  );
  await db
    .update(t)
    .set({
      status: 'submitted',
      outputRef: sql`${output}::json`,
      completedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(t.workspaceId, identity.workspaceId),
        eq(t.runId, identity.runId),
        eq(t.id, identity.id),
      ),
    )
    .catch(rethrowQueryFailure);
  if (task.node_run_id !== null) {
    await wakeWorkflowRun(client, identity.workspaceId, identity.runId);
    await wakeTaskAncestors(client, identity.workspaceId, identity.runId);
  }
}
