import type { QueryResult } from 'pg';
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
import {
  CallbackResponseError,
  type CallbackStore,
  type PreparedCallback,
} from './contract.js';

type Row = Readonly<{
  id: string;
  workspace_id: string;
  run_id: string;
  callback_node_id: string;
  callback_scope_hash: string;
  callback_token_hash: string;
  callback_key_version: string;
  config: unknown;
}>;
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
      const result = await lease.pool.query<Row & { database_time: Date }>(
        'select * from app.resolve_public_pending_callback($1::char(64))',
        [tokenHash],
      );
      signal.throwIfAborted();
      return result.rows[0] === undefined
        ? null
        : {
            ...project(result.rows[0]),
            databaseTime: result.rows[0].database_time,
          };
    },
    keysInUse: async function* (signal) {
      let after: string | null = null;
      do {
        signal.throwIfAborted();
        const page: QueryResult<{
          id: string;
          callback_token_hash: string;
          callback_key_version: string;
        }> = await lease.pool.query(
          'select * from app.pending_callback_key_inventory($1::text)',
          [after],
        );
        if (page.rows.length === 0) return;
        for (const row of page.rows)
          yield {
            id: row.id,
            keyVersion: row.callback_key_version,
            tokenHash: row.callback_token_hash,
          };
        after = page.rows.at(-1)?.callback_key_version ?? null;
      } while (after !== null);
    },
    respond: (input) =>
      withWorkspaceWriteClient(
        lease.pool,
        input.callback.workspaceId,
        input.signal,
        async (client) => {
          const identity = input.callback;
          const workspace = await client.query<{ status: string }>(
            'select status from app.workspaces where id=$1 for share',
            [identity.workspaceId],
          );
          const run = await client.query<{ status: string; closed: boolean }>(
            `select status,(cancel_requested_at is not null or (deadline_at is not null and deadline_at<=clock_timestamp())) closed from app.workflow_runs where workspace_id=$1 and id=$2 for no key update`,
            [identity.workspaceId, identity.runId],
          );
          const found = await client.query<{
            status: string;
            expired: boolean;
            node_run_id: string | null;
            invocation_key: string;
            consumed_at: Date | null;
          }>(
            `select status,(expires_at is not null and expires_at<=clock_timestamp()) expired,node_run_id,invocation_key,consumed_at from app.pending_run_tasks where workspace_id=$1 and run_id=$2 and id=$3 and kind='callback' and callback_token_hash=$4 for update`,
            [
              identity.workspaceId,
              identity.runId,
              identity.id,
              identity.tokenHash,
            ],
          );
          const task = found.rows[0],
            owner = run.rows[0];
          const callbackUnavailable =
            workspace.rows[0]?.status !== 'active' ||
            owner === undefined ||
            owner.closed ||
            !['queued', 'running', 'waiting'].includes(owner.status) ||
            task === undefined ||
            task.expired ||
            task.consumed_at !== null ||
            ['expired', 'refused', 'canceled'].includes(task.status);
          if (callbackUnavailable) throw new CallbackResponseError('closed');
          if (task.status === 'submitted')
            throw new CallbackResponseError('resolved');
          // Normalize escapes and enforce the value bounds before credential redaction.
          const output = input.redactOutput(
            serializeStoredExecutionValue({
              kind: 'inline',
              value: input.output,
            }),
          );
          await client.query(
            `update app.pending_run_tasks set status='submitted',output_ref=$4::json,completed_at=clock_timestamp() where workspace_id=$1 and run_id=$2 and id=$3`,
            [identity.workspaceId, identity.runId, identity.id, output],
          );
          if (task.node_run_id !== null) {
            await wakeWorkflowRun(client, identity.workspaceId, identity.runId);
            await wakeTaskAncestors(
              client,
              identity.workspaceId,
              identity.runId,
            );
          }
        },
      ),
  };
}
