import type { Pool } from 'pg';
import type { z } from 'zod';

import {
  completionSchema,
  DeliveryMismatch,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  type CompleteNodeAttemptResult,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  auditMismatch,
  nodeAttemptConsumerName as consumerName,
  validateDelivery,
} from './node-attempt-run-store-delivery.js';
import {
  applyNodeAttemptCompletion,
  type CompletionReceiptRow,
  type LockedAttemptRow,
} from './node-attempt-run-store-outcomes.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';
import { serializeStoredExecutionValueV1 } from './stored-execution-value.js';

export async function completeNodeAttempt(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['complete']>[0],
): Promise<CompleteNodeAttemptResult> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof completionSchema>;
  try {
    input = completionSchema.parse(inputValue);
  } catch {
    throw new NodeAttemptStateCorruptError();
  }
  let serializedOutput: string | null = null;
  if (
    input.outcome.status === 'succeeded' ||
    input.outcome.status === 'suspended'
  ) {
    try {
      serializedOutput = serializeStoredExecutionValueV1({
        schemaVersion: 1,
        kind: 'inline',
        value: input.outcome.output,
      });
    } catch {
      throw new NodeAttemptOutputInvalidError();
    }
  }
  try {
    return await withWorkspaceWriteClient(
      pool,
      input.lease.workspaceId,
      input.signal,
      async (client) => {
        await validateDelivery(client, {
          workspaceId: input.lease.workspaceId,
          runId: input.lease.runId,
          nodeRunId: input.lease.nodeRunId,
          attemptId: input.lease.attemptId,
          delivery: input.lease.delivery,
          leaseDurationSeconds: 1,
          workerId: input.lease.workerId,
          signal: input.signal,
        });
        const receipt = await client.query<CompletionReceiptRow>(
          `select completed_at,payload_checksum
           from app.inbox_receipts
           where consumer_name=$1 and message_id=$2 and workspace_id=$3
           for update`,
          [
            consumerName,
            input.lease.delivery.outboxEventId,
            input.lease.workspaceId,
          ],
        );
        const receiptRow = receipt.rows[0];
        if (
          receiptRow?.payload_checksum !== input.lease.delivery.payloadChecksum
        )
          throw new NodeAttemptStateCorruptError();

        const run = await client.query<{
          abort_requested: boolean;
        }>(
          `select (
             cancel_requested_at is not null or
             (deadline_at is not null and deadline_at <= clock_timestamp())
           ) abort_requested
           from app.workflow_runs
           where workspace_id=$1 and id=$2 and workflow_version_id=$3
           for update`,
          [
            input.lease.workspaceId,
            input.lease.runId,
            input.lease.workflowVersionId,
          ],
        );
        if (run.rowCount !== 1) throw new NodeAttemptStateCorruptError();
        if (
          input.outcome.status === 'suspended' &&
          run.rows[0]?.abort_requested
        )
          throw new NodeAttemptReconciliationRequiredError();
        const locked = await client.query<LockedAttemptRow>(
          `select attempt.status attempt_status,attempt.fence_token,
                  attempt.lease_owner,attempt.lease_expires_at,
                  (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                  attempt.output_ref,attempt.safe_error_code,
                   attempt.error_summary,attempt.executor_failure_kind,
                   attempt.executor_error_kind,
                   attempt.executor_possibly_dispatched,
                    attempt.retry_decision,node.status node_status,node.wait_kind
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id
            and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$2
             and attempt.node_run_id=$3 and attempt.attempt_number=$4
             and node.workflow_run_id=$5 and node.node_id=$6
             and node.invocation_key=$7
             and node.current_attempt_id=attempt.id
           for update of node,attempt`,
          [
            input.lease.workspaceId,
            input.lease.attemptId,
            input.lease.nodeRunId,
            input.lease.attemptNumber,
            input.lease.runId,
            input.lease.nodeId,
            input.lease.invocationKey,
          ],
        );
        const row = locked.rows[0];
        if (row === undefined) throw new NodeAttemptStateCorruptError();
        return applyNodeAttemptCompletion(
          client,
          input,
          row,
          receiptRow,
          serializedOutput,
        );
      },
    );
  } catch (error: unknown) {
    if (error instanceof DeliveryMismatch)
      return auditMismatch(
        pool,
        input.lease.workspaceId,
        input.lease.delivery,
        input.signal,
      );
    throw error;
  }
}
