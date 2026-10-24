import type { Pool } from 'pg';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import type { DatabaseConfig } from '../../../config.js';
import { withWorkspaceWriteClient } from '../../../attempts/transactions.repository.js';
import { NodeAttemptReconciliationRequiredError } from '../../../attempts/errors.js';
import type { NodeWebhookResponseReceipt } from '@pertexo/node-sdk';
import type { WebhookResponseStore, WriteWebhookResponse } from './contract.js';

export function createWebhookResponseStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WebhookResponseStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    respond: (input) => writeWebhookResponse(lease.pool, input),
    close: () => lease.close(),
  };
}
function writeWebhookResponse(
  pool: Pool,
  input: WriteWebhookResponse,
): Promise<NodeWebhookResponseReceipt> {
  return withWorkspaceWriteClient(
    pool,
    input.workspaceId,
    input.signal,
    async (client) => {
      // Run → node/attempt → response is also completion's lock order.
      const run = await client.query<{ status: string }>(
        `select status from app.workflow_runs where workspace_id=$1 and id=$2 for update`,
        [input.workspaceId, input.runId],
      );
      if (
        run.rows[0] === undefined ||
        !['running', 'waiting'].includes(run.rows[0].status)
      )
        throw new NodeAttemptReconciliationRequiredError();
      const attempt = await client.query<{ id: string }>(
        `select attempt.id
      from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
      where attempt.workspace_id=$1 and attempt.id=$2 and attempt.node_run_id=$3 and attempt.attempt_number=$4
        and node.workflow_run_id=$5 and node.node_id=$6 and node.invocation_key=$7
      for update of node,attempt`,
        [
          input.workspaceId,
          input.attemptId,
          input.nodeRunId,
          input.attemptNumber,
          input.runId,
          input.nodeId,
          input.invocationKey,
        ],
      );
      if (attempt.rows[0] === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      const current = await client.query<{
        node_run_id: string | null;
        invocation_key: string | null;
        status_code: number | null;
      }>(
        `select node_run_id,invocation_key,status_code from app.webhook_run_responses where workspace_id=$1 and run_id=$2 for update`,
        [input.workspaceId, input.runId],
      );
      // Evaluate time after every lock wait, not in the locking SELECT's snapshot.
      const fence = await client.query<{ valid: boolean }>(
        `select (attempt.status='running' and attempt.lease_owner=$4 and attempt.fence_token=$5 and attempt.lease_expires_at>clock_timestamp() and attempt.dispatch_marked_at is not null and node.current_attempt_id=attempt.id and run.cancel_requested_at is null and (run.deadline_at is null or run.deadline_at>clock_timestamp())) valid
      from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
      join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
      where attempt.workspace_id=$1 and attempt.id=$2 and run.id=$3`,
        [
          input.workspaceId,
          input.attemptId,
          input.runId,
          input.workerId,
          input.fenceToken,
        ],
      );
      if (!(fence.rows[0]?.valid ?? false))
        throw new NodeAttemptReconciliationRequiredError();
      const row = current.rows[0];
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
      const written = await client.query(
        `update app.webhook_run_responses response set status_code=$3,content_type=$4,headers=$5::jsonb,body=$6,node_run_id=$7,invocation_key=$8,responded_at=clock_timestamp() where workspace_id=$1 and run_id=$2
          and exists(select 1 from app.node_attempts attempt where attempt.workspace_id=$1 and attempt.id=$9 and attempt.lease_expires_at>clock_timestamp())
          and exists(select 1 from app.workflow_runs run where run.workspace_id=$1 and run.id=$2 and (run.deadline_at is null or run.deadline_at>clock_timestamp()))`,
        [
          input.workspaceId,
          input.runId,
          response.statusCode,
          response.contentType,
          JSON.stringify(response.headers),
          response.body,
          input.nodeRunId,
          input.invocationKey,
          input.attemptId,
        ],
      );
      if (written.rowCount !== 1)
        throw new NodeAttemptReconciliationRequiredError();
      return { outcome: 'responded', statusCode: response.statusCode };
    },
  );
}
