import type { Pool } from 'pg';
import type { z } from 'zod';

import {
  heartbeatSchema,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';

export async function heartbeatNodeAttempt(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['heartbeat']>[0],
): Promise<
  Readonly<{
    leaseExpiresAt: Date;
    abortRequested: boolean;
    abortReason?: 'canceled' | 'timed_out';
  }>
> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof heartbeatSchema>;
  try {
    input = heartbeatSchema.parse(inputValue);
  } catch {
    throw new NodeAttemptStateCorruptError();
  }
  return withWorkspaceWriteClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const result = await client.query<{
        abort_reason: 'canceled' | 'timed_out' | null;
        abort_requested: boolean;
        lease_expires_at: Date;
      }>(
        `update app.node_attempts attempt
         set lease_expires_at=clock_timestamp()+make_interval(secs=>$7),
             updated_at=clock_timestamp()
         from app.node_runs node,app.workflow_runs run
         where attempt.workspace_id=$1 and attempt.id=$2
           and attempt.node_run_id=$3 and attempt.attempt_number=$4
           and attempt.status='running' and attempt.lease_owner=$5
           and attempt.fence_token=$6
           and attempt.lease_expires_at > clock_timestamp()
           and node.workspace_id=attempt.workspace_id
           and node.id=attempt.node_run_id and node.workflow_run_id=$8
           and node.node_id=$9 and node.invocation_key=$10
           and node.current_attempt_id=attempt.id
           and run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
           and run.workflow_version_id=$11
         returning attempt.lease_expires_at,
           (run.cancel_requested_at is not null or
            (run.deadline_at is not null and
             run.deadline_at <= clock_timestamp())) as abort_requested,
           case
             when run.cancel_requested_at is not null then 'canceled'
             when run.deadline_at is not null and
                  run.deadline_at <= clock_timestamp() then 'timed_out'
             else null
           end as abort_reason`,
        [
          input.lease.workspaceId,
          input.lease.attemptId,
          input.lease.nodeRunId,
          input.lease.attemptNumber,
          input.lease.workerId,
          input.lease.fenceToken,
          input.leaseDurationSeconds,
          input.lease.runId,
          input.lease.nodeId,
          input.lease.invocationKey,
          input.lease.workflowVersionId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new NodeAttemptReconciliationRequiredError();
      return Object.freeze({
        leaseExpiresAt: new Date(row.lease_expires_at),
        abortRequested: row.abort_requested,
        ...(row.abort_reason === null ? {} : { abortReason: row.abort_reason }),
      });
    },
  );
}
