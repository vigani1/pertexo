import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../../variables/values.queries.js';
import type { PoolClient } from 'pg';
import type { RunAdvanceState } from '../contract.js';
import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';

/** This projection is needed only when a callable run is about to succeed. */
export async function readRunCompletionValues(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    inputRef: unknown;
    variableSetRevision: number | null;
    nodeIds: readonly string[] | undefined;
  }>,
): ReturnType<RunAdvanceState['readCompletionValues']> {
  const storedInput =
    input.inputRef === null
      ? undefined
      : parseStoredExecutionValue(input.inputRef);
  const result =
    input.nodeIds?.length === 0
      ? { rows: [] }
      : await client.query<{
          node_id: string;
          invocation_key: string;
          output_ref: unknown;
        }>(
          `select node.node_id, node.invocation_key,
            case when node.reused_source_run_id is not null
                   and node.reused_source_node_run_id is not null and node.reused_source_completed_at is not null
                   and node.current_attempt_id is null and node.current_attempt_number is null
                   and node.status='succeeded' then node.output_ref
                 when task.id is not null then task.output_ref
                 when call.id is not null then call.result_ref
                 else coalesce(attempt.output_ref, node.output_ref) end output_ref
       from app.node_runs node
       left join app.node_attempts attempt
         on attempt.workspace_id = node.workspace_id
        and attempt.node_run_id = node.id
        and attempt.id = node.current_attempt_id
        and attempt.attempt_number = node.current_attempt_number
       left join app.workflow_calls call
         on call.workspace_id=node.workspace_id and call.parent_run_id=node.workflow_run_id
        and call.invocation_key=node.invocation_key and call.status='succeeded'
       left join app.pending_run_tasks task
         on task.workspace_id=node.workspace_id and task.run_id=node.workflow_run_id
        and task.node_run_id=node.id and task.invocation_key=node.invocation_key
        and task.status in ('approved','rejected','submitted')
       where node.workspace_id = $1 and node.workflow_run_id = $2
         and ($3::varchar[] is null or node.node_id = any($3::varchar[]))
         and (node.status = 'succeeded' or
              (node.status in ('running','waiting') and attempt.status = 'succeeded' and node.control_kind is null) or
              (node.status='waiting' and (task.id is not null or call.id is not null)))
       order by node.invocation_key`,
          [input.workspaceId, input.runId, input.nodeIds ?? null],
        );
  return {
    variables: await readVariableSetValues(
      drizzle(client),
      input.workspaceId,
      input.variableSetRevision,
    ),
    runInput: storedInput?.kind === 'inline' ? storedInput.value : undefined,
    outputs: result.rows.map((row) => {
      const stored =
        row.output_ref === null
          ? undefined
          : parseStoredExecutionValue(row.output_ref);
      return {
        nodeId: row.node_id,
        invocationKey: row.invocation_key,
        value: stored?.kind === 'inline' ? stored.value : undefined,
      };
    }),
  };
}
