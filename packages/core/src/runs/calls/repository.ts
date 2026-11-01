import { readPendingCall } from './admission.queries.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { workflowCalls, workflowRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { terminalRunStatuses } from '../advance/plan.js';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { RunAdvanceInput } from '../advance/contract.js';
import {
  auditCoordinatorDeliveryMismatch,
  DeliveryMismatch,
  validateAuthoritativeAdvanceDelivery,
} from '../advance/receipts.repository.js';
import { withCoordinatorWriteClient } from '../advance/transactions.repository.js';
import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import type { WorkflowCallStore } from './contract.js';
import { acceptPendingCall } from './accept.repository.js';
import { applyIncomingCallCancellation } from './controls.repository.js';
import { wakeWorkflowRun, deferWorkflowRun } from './wakeup.repository.js';

async function performOutgoingActions(
  client: PoolClient,
  input: RunAdvanceInput,
  prepareChild: InitialCheckpointFactory,
): Promise<void> {
  const { workspaceId, runId } = input;
  const db = drizzle(client),
    c = workflowCalls;
  const [loan] = await db
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        eq(c.workspaceId, workspaceId),
        eq(c.parentRunId, runId),
        eq(c.slotLent, true),
      ),
    )
    .catch(rethrowQueryFailure);
  if (loan !== undefined) {
    const result = await db
      .execute<{ returned: boolean }>(
        sql`select app.return_workflow_run_slot(${workspaceId},${loan.id},${input.delivery.outboxEventId}) returned`,
      )
      .catch(rethrowQueryFailure);
    if (result.rows[0]?.returned ?? false) {
      const incoming = await db
        .select({ parent_run_id: c.parentRunId })
        .from(c)
        .where(
          and(
            eq(c.workspaceId, workspaceId),
            eq(c.childRunId, runId),
            eq(c.slotLent, true),
          ),
        )
        .catch(rethrowQueryFailure);
      for (const row of incoming)
        await wakeWorkflowRun(
          client,
          workspaceId,
          row.parent_run_id,
          input.traceparent,
        );
    }
    if (!(result.rows[0]?.returned ?? false)) {
      const child = await db
        .select({ status: workflowRuns.status })
        .from(c)
        .innerJoin(
          workflowRuns,
          and(
            eq(workflowRuns.workspaceId, c.workspaceId),
            eq(workflowRuns.id, c.childRunId),
          ),
        )
        .where(and(eq(c.workspaceId, workspaceId), eq(c.id, loan.id)))
        .catch(rethrowQueryFailure);
      if (child[0] !== undefined && terminalRunStatuses.has(child[0].status))
        await deferWorkflowRun(client, workspaceId, runId, input.traceparent);
    }
    return;
  }
  const [call] = await readPendingCall(client, { workspaceId, runId });
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
  const workspaceId = input.workspaceId;
  const runId = input.runId;
  const delivery = input.delivery;
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
