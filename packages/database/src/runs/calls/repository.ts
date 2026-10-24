import { terminalRunStatuses } from '../advance/plan.js';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import {
  coordinatorDeliverySchema,
  coordinatorIdentitySchema,
  type RunAdvanceInput,
} from '../advance/contract.js';
import {
  auditCoordinatorDeliveryMismatch,
  DeliveryMismatch,
  validateAuthoritativeAdvanceDelivery,
} from '../advance/receipts.repository.js';
import { withCoordinatorWriteClient } from '../advance/transactions.repository.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import type { WorkflowCallStore } from './contract.js';
import { acceptPendingCall, type PendingWorkflowCall } from './accept.repository.js';
import { applyIncomingCallCancellation } from './controls.repository.js';
import { wakeWorkflowRun, deferWorkflowRun } from './wakeup.repository.js';

async function performOutgoingActions(
  client: PoolClient,
  input: RunAdvanceInput,
  prepareChild: InitialCheckpointFactory,
): Promise<void> {
  const { workspaceId, runId } = input;
  const loan = await client.query<{ id: string }>(
    'select id from app.workflow_calls where workspace_id=$1 and parent_run_id=$2 and slot_lent',
    [workspaceId, runId],
  );
  if (loan.rows[0] !== undefined) {
    const result = await client.query<{ returned: boolean }>(
      'select app.return_workflow_run_slot($1,$2,$3) returned',
      [workspaceId, loan.rows[0].id, input.delivery.outboxEventId],
    );
    if (result.rows[0]?.returned ?? false) {
      const incoming = await client.query<{ parent_run_id: string }>(
        'select parent_run_id from app.workflow_calls where workspace_id=$1 and child_run_id=$2 and slot_lent',
        [workspaceId, runId],
      );
      for (const row of incoming.rows)
        await wakeWorkflowRun(
          client,
          workspaceId,
          row.parent_run_id,
          input.traceparent,
        );
    }
    if (!(result.rows[0]?.returned ?? false)) {
      const child = await client.query<{ status: string }>(
        `select child.status from app.workflow_calls call join app.workflow_runs child on child.workspace_id=call.workspace_id and child.id=call.child_run_id where call.workspace_id=$1 and call.id=$2`,
        [workspaceId, loan.rows[0].id],
      );
      if (
        child.rows[0] !== undefined &&
        terminalRunStatuses.has(child.rows[0].status)
      )
        await deferWorkflowRun(client, workspaceId, runId, input.traceparent);
    }
    return;
  }
  const pending = await client.query<PendingWorkflowCall>(
    `select id,invocation_key,target_workflow_id,target_version_id,target_checksum,input_ref,input_checksum,deadline_at
 from app.workflow_calls where workspace_id=$1 and parent_run_id=$2 and status='pending'
 order by invocation_key limit 1`,
    [workspaceId, runId],
  );
  const call = pending.rows[0];
  if (call !== undefined)
    await acceptPendingCall(client, {
      workspaceId,
      parentRunId: runId,
      call,
      prepareChild,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    });
}

async function performActions(
  pool: Pool,
  input: RunAdvanceInput,
  prepareChild: InitialCheckpointFactory,
): Promise<void> {
  const workspaceId = coordinatorIdentitySchema.parse(input.workspaceId);
  const runId = coordinatorIdentitySchema.parse(input.runId);
  const delivery = coordinatorDeliverySchema.parse(input.delivery);
  try {
    const validated = { ...input, workspaceId, runId, delivery };
    const controlled = await withCoordinatorWriteClient(
      pool,
      workspaceId,
      input.signal,
      async (client) => {
        await validateAuthoritativeAdvanceDelivery(
          client,
          workspaceId,
          runId,
          delivery,
        );
        if (
          await applyIncomingCallCancellation(
            client,
            workspaceId,
            runId,
            input.traceparent,
          )
        )
          return true;
        await performOutgoingActions(client, validated, prepareChild);
        return false;
      },
    );
    // A cancellation held this run before target prerequisites. Commit it
    // before an outgoing action acquires the target-first spawn lock order.
    if (controlled)
      await withCoordinatorWriteClient(
        pool,
        workspaceId,
        input.signal,
        async (client) => {
          await validateAuthoritativeAdvanceDelivery(
            client,
            workspaceId,
            runId,
            delivery,
          );
          await performOutgoingActions(client, validated, prepareChild);
        },
      );
  } catch (error) {
    if (error instanceof DeliveryMismatch)
      return auditCoordinatorDeliveryMismatch(
        pool,
        workspaceId,
        delivery,
        input.signal,
      );
    throw error;
  }
}

/** Config is the existing maintenance authority; actions never use the app pool. */
export function createWorkflowCallStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowCallStore {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    performActions: (
      input: RunAdvanceInput,
      prepareChild: InitialCheckpointFactory,
    ) => performActions(lease.pool, input, prepareChild),
    close: () => lease.close(),
  });
}
