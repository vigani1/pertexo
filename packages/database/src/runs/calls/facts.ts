import type { PoolClient } from 'pg';
import type { WorkflowCallOutcome } from '@pertexo/workflow-engine';

/** Immutable child outcomes use the parent's retained node scope, not its event cursor. */
export async function readCallFacts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<
  Readonly<{
    hasExecutionSlot: boolean;
    hasHumanChild: boolean;
    callOutcomes: readonly WorkflowCallOutcome[];
  }>
> {
  const rows = await client.query<{
    id: string;
    invocation_key: string;
    node_id: string;
    branch_context: Pick<WorkflowCallOutcome, 'branchPath' | 'iterationPath'>;
    status: WorkflowCallOutcome['status'] | 'pending' | 'accepted';
    safe_error_code: string | null;
    slot_lent: boolean;
    consumed_at: Date | null;
    child_wait: Date | null;
  }>(
    `select call.id,call.invocation_key,call.status,call.safe_error_code,
            call.slot_lent,call.consumed_at,node.node_id,node.branch_context,child.human_wait_started_at child_wait
     from app.workflow_calls call
     join app.node_runs node on node.workspace_id=call.workspace_id
       and node.workflow_run_id=call.parent_run_id and node.invocation_key=call.invocation_key
     left join app.workflow_runs child on child.workspace_id=call.workspace_id and child.id=call.child_run_id
     where call.workspace_id=$1 and call.parent_run_id=$2
       and (call.slot_lent or call.consumed_at is null)
     order by call.invocation_key`,
    [workspaceId, runId],
  );
  return {
    hasExecutionSlot: !rows.rows.some(({ slot_lent }) => slot_lent),
    hasHumanChild: rows.rows.some(({ child_wait }) => child_wait !== null),
    callOutcomes: rows.rows.flatMap((row) => {
      const status = row.status;
      const ignoresCallOutcome =
        row.consumed_at !== null ||
        status === 'pending' ||
        status === 'accepted';
      return ignoresCallOutcome
        ? []
        : [
            {
              ...row.branch_context,
              callId: row.id,
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              status,
              ...(row.safe_error_code === null
                ? {}
                : { reasonCode: row.safe_error_code }),
            },
          ];
    }),
  };
}
