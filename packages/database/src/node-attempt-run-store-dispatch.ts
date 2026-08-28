import type { Pool } from 'pg';
import type { z } from 'zod';

import {
  dispatchSchema,
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';

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
        const fencedConnection = await client.query<{
          fence_current: boolean;
        }>(
          `select app.connection_dispatch_fence_current(
             $1,$2,$3,$4,$5
           ) fence_current`,
          [
            input.lease.workspaceId,
            input.connectionFence.connectionId,
            input.connectionFence.expectedProviderKey,
            input.connectionFence.expectedAuthType,
            input.connectionFence.secretVersionId,
          ],
        );
        if (fencedConnection.rows[0]?.fence_current !== true)
          throw new NodeAttemptConnectionFenceError();
      }
      const lockedNode = await client.query<{
        provider_dispatch_binding: string | null;
      }>(
        `select node.provider_dispatch_binding
         from app.node_runs node
         join app.workflow_runs run
           on run.workspace_id=node.workspace_id
          and run.id=node.workflow_run_id
         where node.workspace_id=$1 and node.id=$2
           and node.workflow_run_id=$3 and node.node_id=$4
           and node.invocation_key=$5 and node.current_attempt_id=$6
           and run.workflow_version_id=$7
         for update of node`,
        [
          input.lease.workspaceId,
          input.lease.nodeRunId,
          input.lease.runId,
          input.lease.nodeId,
          input.lease.invocationKey,
          input.lease.attemptId,
          input.lease.workflowVersionId,
        ],
      );
      const existingBinding = lockedNode.rows[0]?.provider_dispatch_binding;
      if (existingBinding === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      if (
        input.providerDispatchBinding !== undefined &&
        existingBinding !== null &&
        existingBinding !== input.providerDispatchBinding
      )
        throw new NodeAttemptDispatchBindingMismatchError();
      if (
        input.providerDispatchBinding !== undefined &&
        existingBinding === null
      )
        await client.query(
          `update app.node_runs
           set provider_dispatch_binding=$3,updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
          [
            input.lease.workspaceId,
            input.lease.nodeRunId,
            input.providerDispatchBinding,
          ],
        );
      const result = await client.query<{ dispatch_marked_at: Date }>(
        `update app.node_attempts attempt
         set dispatch_marked_at=coalesce(dispatch_marked_at,clock_timestamp()),
             updated_at=clock_timestamp()
         from app.node_runs node,app.workflow_runs run
         where attempt.workspace_id=$1 and attempt.id=$2
           and attempt.node_run_id=$3 and attempt.attempt_number=$4
           and attempt.status='running' and attempt.lease_owner=$5
           and attempt.fence_token=$6
           and attempt.lease_expires_at > clock_timestamp()
           and node.workspace_id=attempt.workspace_id
           and node.id=attempt.node_run_id
           and node.workflow_run_id=$7 and node.node_id=$8
           and node.invocation_key=$9 and node.current_attempt_id=attempt.id
           and run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
           and run.workflow_version_id=$10
         returning attempt.dispatch_marked_at`,
        [
          input.lease.workspaceId,
          input.lease.attemptId,
          input.lease.nodeRunId,
          input.lease.attemptNumber,
          input.lease.workerId,
          input.lease.fenceToken,
          input.lease.runId,
          input.lease.nodeId,
          input.lease.invocationKey,
          input.lease.workflowVersionId,
        ],
      );
      const dispatchedAt = result.rows[0]?.dispatch_marked_at;
      if (dispatchedAt === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      return Object.freeze({ dispatchedAt: new Date(dispatchedAt) });
    },
  );
}
