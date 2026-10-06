import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  parseWorkspaceId,
  workspaceTransactionFromClient,
} from '../../tenant-access/workspace.js';
import { appendLockedRunEvent } from '../runs/run-events.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../transport/outbox.js';
import { NodeAttemptStateCorruptError } from './node-attempt-run-store-contract.js';

/** Existing claim owner holds run/node/attempt locks and actual pending delivery receipt. */
export async function settleNativeUnclaimedControl(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowVersionId: string;
    nodeRunId: string;
    attemptId: string;
    invocationKey: string;
    nodeId: string;
    attemptNumber: number;
    cancellationRequested: boolean;
  }>,
): Promise<string | undefined> {
  const eligible = await client.query<{ eligible: boolean }>(
    `select app.workflow_call_native_run_control_valid($1::uuid,$2::uuid) as eligible`,
    [input.runId, input.workflowVersionId],
  );
  if (eligible.rows.length !== 1 || eligible.rows[0]?.eligible !== true)
    return undefined;
  const status = input.cancellationRequested ? 'canceled' : 'timed_out';
  const safeErrorCode = input.cancellationRequested
    ? 'execution.canceled'
    : 'execution.deadline_exceeded';
  const attempt = await client.query(
    `update app.node_attempts set status=$3,safe_error_code=$4,
       completed_at=clock_timestamp(),updated_at=clock_timestamp()
       where workspace_id=$1 and id=$2 and node_run_id=$5 and attempt_number=$6
         and status='ready' and fence_token=0 and started_at is null
         and lease_owner is null and lease_expires_at is null and dispatch_marked_at is null
         and output_ref is null and executor_possibly_dispatched is null`,
    [
      input.workspaceId,
      input.attemptId,
      status,
      safeErrorCode,
      input.nodeRunId,
      input.attemptNumber,
    ],
  );
  if (attempt.rowCount !== 1) throw new NodeAttemptStateCorruptError();
  const node = await client.query(
    `update app.node_runs set status=$3,safe_error_code=$4,
       completed_at=clock_timestamp(),updated_at=clock_timestamp()
       where workspace_id=$1 and id=$2 and workflow_run_id=$5
         and current_attempt_id=$6 and current_attempt_number=$7 and status='ready'
         and started_at is null and output_ref is null and control_kind is null`,
    [
      input.workspaceId,
      input.nodeRunId,
      status,
      safeErrorCode,
      input.runId,
      input.attemptId,
      input.attemptNumber,
    ],
  );
  if (node.rowCount !== 1) throw new NodeAttemptStateCorruptError();
  const transaction = workspaceTransactionFromClient(
    client,
    parseWorkspaceId(input.workspaceId),
  );
  await appendLockedRunEvent(transaction, input.runId, {
    type: status === 'canceled' ? 'node.canceled' : 'node.timed_out',
    payload: {
      nodeRunId: input.nodeRunId,
      attemptId: input.attemptId,
      invocationKey: input.invocationKey,
      nodeId: input.nodeId,
      attemptNumber: input.attemptNumber,
      safeErrorCode,
    },
  });
  const outboxEventId = generatePersistedId();
  const payload = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    runId: input.runId,
    outboxEventId,
  };
  await insertOutboxEvent(transaction, {
    id: outboxEventId,
    jobName: 'advance-workflow-run',
    schemaVersion: 1,
    aggregateType: 'workflow-run',
    aggregateId: input.runId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });
  return outboxEventId;
}
