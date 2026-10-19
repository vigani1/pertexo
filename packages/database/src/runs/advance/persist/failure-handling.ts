import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../contract.js';
import type { RunTransitionPlan } from '../plan.js';
import { serializeStoredExecutionJsonValue } from '../../../platform/stored-execution-value.js';

/** Source evidence and disposition share the checkpoint/admission transaction. */
export async function persistFailureHandling(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<void> {
  for (const selection of plan.failureValues ?? []) {
    const source = plan.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === selection.value.invocationKey,
    );
    if (source?.failureHandling?.disposition !== 'pending')
      throw new CoordinatorRunStateCorruptError();
    const written = await client.query(
      `update app.node_runs set failure_ref=$4::json,
       failure_handler_entry_key=$5,failure_handler_sink_key=$6,
       failure_handling='pending',updated_at=clock_timestamp()
       where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3
       and status='failed' and current_attempt_number=$7 and failure_ref is null`,
      [
        workspaceId,
        runId,
        selection.value.invocationKey,
        serializeStoredExecutionJsonValue({
          kind: 'inline',
          value: selection.value,
        }),
        selection.entryInvocationKey,
        source.failureHandling.sinkInvocationKey,
        selection.value.attemptNumber,
      ],
    );
    if (written.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
  for (const event of plan.events) {
    if (
      event.name !== 'node.failure_handled' ||
      event.invocationKey === undefined
    )
      continue;
    const source = plan.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === event.invocationKey,
    );
    if (source?.failureHandling?.disposition !== 'handled')
      throw new CoordinatorRunStateCorruptError();
    const written = await client.query(
      `update app.node_runs set failure_handling='handled',updated_at=clock_timestamp()
       where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3
       and status='failed' and failure_handling='pending' and failure_handler_sink_key=$4`,
      [
        workspaceId,
        runId,
        event.invocationKey,
        source.failureHandling.sinkInvocationKey,
      ],
    );
    if (written.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}
