import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

import {
  DeliveryMismatch,
  NodeAttemptControlActiveError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  branchContextSchema,
  claimDeliverySchema,
  type NodeAttemptClaimResult,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  auditMismatch,
  claimReceipt,
  completeReceipt,
  validateDelivery,
} from './node-attempt-run-store-delivery.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

async function appendStartedEvent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    nodeRunId: string;
    attemptId: string;
    invocationKey: string;
    nodeId: string;
    attemptNumber: number;
  }>,
): Promise<void> {
  const sequence = await client.query<{ sequence: number }>(
    `select coalesce(max(sequence),0)::int + 1 as sequence
     from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
    [input.workspaceId, input.runId],
  );
  const next = sequence.rows[0]?.sequence;
  if (next === undefined) throw new NodeAttemptStateCorruptError();
  const payload = serializeStoredExecutionJsonValue({
    schemaVersion: 1,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: input.nodeId,
    attemptNumber: input.attemptNumber,
  });
  await client.query(
    `insert into app.run_events (
       workspace_id,workflow_run_id,sequence,type,payload
     ) values ($1,$2,$3,'node.started',$4::jsonb)`,
    [input.workspaceId, input.runId, next, payload],
  );
}

export async function claimNodeAttemptDelivery(
  pool: Pool,
  inputValue: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
): Promise<NodeAttemptClaimResult> {
  assertNotAborted(inputValue.signal);
  let input: z.output<typeof claimDeliverySchema>;
  try {
    input = claimDeliverySchema.parse(inputValue);
  } catch {
    throw new NodeAttemptDeliveryMismatchError();
  }
  try {
    return await withWorkspaceWriteClient(
      pool,
      input.workspaceId,
      input.signal,
      async (client) => {
        await validateDelivery(client, input);
        const receipt = await claimReceipt(
          client,
          input.workspaceId,
          input.delivery,
        );
        if (receipt === 'completed')
          return Object.freeze({ kind: 'duplicate' as const });

        const candidate = await client.query<{ run_id: string }>(
          `select node.workflow_run_id as run_id
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
          [input.workspaceId, input.attemptId],
        );
        if (candidate.rows[0]?.run_id !== input.runId)
          throw new NodeAttemptStateCorruptError();
        const run = await client.query<{
          cancel_requested_at: Date | null;
          control_active: boolean;
          deadline_at: Date | null;
          workflow_version_id: string;
        }>(
          `select workflow_version_id,cancel_requested_at,deadline_at,
                      (cancel_requested_at is not null or
                       (deadline_at is not null and
                        deadline_at <= clock_timestamp())) control_active
               from app.workflow_runs
               where workspace_id=$1 and id=$2 for update`,
          [input.workspaceId, input.runId],
        );
        const runRow = run.rows[0];
        if (runRow === undefined) throw new NodeAttemptStateCorruptError();
        const locked = await client.query<{
          admission_kind: 'execute' | 'retry' | 'wait_resume';
          attempt_number: number;
          attempt_status: string;
          dispatch_marked_at: Date | null;
          fence_token: string;
          branch_context: unknown;
          invocation_key: string;
          lease_valid: boolean;
          lease_expires_at: Date | null;
          node_id: string;
          node_status: string;
          provider_idempotency_key: string | null;
          provider_dispatch_binding: string | null;
          provider_dispatch_unresolved: boolean;
          side_effect_class: string;
        }>(
          `select attempt.attempt_number,attempt.admission_kind,
                      attempt.status as attempt_status,
                      attempt.dispatch_marked_at,attempt.fence_token,
                      attempt.lease_expires_at,
                      (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                       node.invocation_key,node.node_id,node.branch_context,
                      node.status as node_status,attempt.side_effect_class,
                       attempt.provider_idempotency_key,
                       node.provider_dispatch_binding,
                       (attempt.dispatch_marked_at is not null or exists (
                         select 1 from app.node_attempts prior
                         where prior.workspace_id=attempt.workspace_id
                           and prior.node_run_id=attempt.node_run_id
                           and prior.attempt_number < attempt.attempt_number
                           and prior.executor_possibly_dispatched is true
                           and prior.retry_decision='retry'
                       )) provider_dispatch_unresolved
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2
                 and attempt.node_run_id=$3 and node.workflow_run_id=$4
                 and node.current_attempt_id=attempt.id
                 and node.current_attempt_number=attempt.attempt_number
               for update of node,attempt`,
          [input.workspaceId, input.attemptId, input.nodeRunId, input.runId],
        );
        const row = locked.rows[0];
        if (row === undefined) throw new NodeAttemptStateCorruptError();
        if (
          [
            'succeeded',
            'failed',
            'canceled',
            'timed_out',
            'outcome_unknown',
          ].includes(row.attempt_status)
        ) {
          await completeReceipt(client, input.workspaceId, input.delivery);
          return Object.freeze({ kind: 'duplicate' as const });
        }
        if (row.attempt_status === 'running') {
          if (row.lease_expires_at !== null && row.lease_valid)
            return Object.freeze({ kind: 'duplicate' as const });
          throw new NodeAttemptReconciliationRequiredError();
        }
        if (row.attempt_status !== 'ready' || row.node_status !== 'ready')
          throw new NodeAttemptStateCorruptError();
        if (runRow.control_active) throw new NodeAttemptControlActiveError();
        if (
          row.side_effect_class !== 'safe' &&
          row.side_effect_class !== 'idempotent_with_key' &&
          row.side_effect_class !== 'unsafe'
        )
          throw new NodeAttemptStateCorruptError();
        const branchContext =
          row.branch_context === null
            ? undefined
            : branchContextSchema.safeParse(row.branch_context);
        if (branchContext !== undefined && !branchContext.success)
          throw new NodeAttemptStateCorruptError();

        const claimed = await client.query<{
          fence_token: string;
          lease_expires_at: Date;
        }>(
          `update app.node_attempts
               set status='running',lease_owner=$3,
                   lease_expires_at=clock_timestamp()+make_interval(secs=>$4),
                   fence_token=fence_token+1,
                   started_at=coalesce(started_at,clock_timestamp()),
                   updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2
               returning fence_token,lease_expires_at`,
          [
            input.workspaceId,
            input.attemptId,
            input.workerId,
            input.leaseDurationSeconds,
          ],
        );
        const claim = claimed.rows[0];
        if (claim === undefined) throw new NodeAttemptStateCorruptError();
        await client.query(
          `update app.node_runs
               set status='running',started_at=coalesce(started_at,clock_timestamp()),
                   updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2`,
          [input.workspaceId, input.nodeRunId],
        );
        await appendStartedEvent(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          attemptId: input.attemptId,
          invocationKey: row.invocation_key,
          nodeId: row.node_id,
          attemptNumber: row.attempt_number,
        });
        const lease: NodeAttemptLease = Object.freeze({
          workspaceId: input.workspaceId,
          runId: input.runId,
          workflowVersionId: runRow.workflow_version_id,
          nodeRunId: input.nodeRunId,
          attemptId: input.attemptId,
          attemptNumber: row.attempt_number,
          admissionKind: row.admission_kind,
          invocationKey: row.invocation_key,
          nodeId: row.node_id,
          ...(branchContext?.data.branchPath === undefined ||
          branchContext.data.branchPath.length === 0
            ? {}
            : { branchPath: branchContext.data.branchPath }),
          ...(branchContext?.data.iterationPath === undefined ||
          branchContext.data.iterationPath.length === 0
            ? {}
            : { iterationPath: branchContext.data.iterationPath }),
          sideEffectClass: row.side_effect_class,
          ...(row.provider_idempotency_key === null
            ? {}
            : { providerIdempotencyKey: row.provider_idempotency_key }),
          ...(row.provider_dispatch_binding === null
            ? {}
            : { providerDispatchBinding: row.provider_dispatch_binding }),
          ...(row.provider_dispatch_unresolved
            ? { providerDispatchUnresolved: true as const }
            : {}),
          workerId: input.workerId,
          fenceToken: Number(claim.fence_token),
          leaseExpiresAt: new Date(claim.lease_expires_at),
          delivery: Object.freeze(input.delivery),
        });
        if (!Number.isSafeInteger(lease.fenceToken) || lease.fenceToken <= 0)
          throw new NodeAttemptStateCorruptError();
        return Object.freeze({ kind: 'claimed' as const, lease });
      },
    );
  } catch (error: unknown) {
    if (error instanceof DeliveryMismatch)
      return auditMismatch(
        pool,
        input.workspaceId,
        input.delivery,
        input.signal,
      );
    throw error;
  }
}
