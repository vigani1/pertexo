import type { Pool } from 'pg';

import {
  recordInputSchema,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import { withWorkspaceWriteClient } from './node-attempt-run-store-transactions.js';
import { serializeStoredExecutionValueV1 } from '../stored-execution-value.js';

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
  const parsed = recordInputSchema.safeParse(request);
  if (!parsed.success || parsed.data.signal.aborted) return { recorded: false };
  const { lease, signal } = parsed.data;
  let stored: string;
  try {
    stored = serializeStoredExecutionValueV1({
      schemaVersion: 1,
      kind: 'inline',
      value: parsed.data.input,
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
        const result = await client.query(
          `update app.node_runs node
           set input_ref=$11::jsonb,updated_at=clock_timestamp()
           from app.node_attempts attempt,app.workflow_runs run
           where node.workspace_id=$1 and node.id=$3
             and node.current_attempt_id=$2
             and node.workflow_run_id=$7 and node.node_id=$8
             and node.invocation_key=$9
             and attempt.workspace_id=node.workspace_id and attempt.id=$2
             and attempt.node_run_id=node.id and attempt.attempt_number=$4
             and attempt.status='running' and attempt.lease_owner=$5
             and attempt.fence_token=$6
             and attempt.lease_expires_at > clock_timestamp()
             and run.workspace_id=node.workspace_id
             and run.id=node.workflow_run_id
             and run.workflow_version_id=$10`,
          [
            lease.workspaceId,
            lease.attemptId,
            lease.nodeRunId,
            lease.attemptNumber,
            lease.workerId,
            lease.fenceToken,
            lease.runId,
            lease.nodeId,
            lease.invocationKey,
            lease.workflowVersionId,
            stored,
          ],
        );
        return { recorded: result.rowCount === 1 };
      },
    );
  } catch {
    return { recorded: false };
  }
}
