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
            coalesce(attempt.output_ref, node.output_ref) output_ref
       from app.node_runs node
       left join app.node_attempts attempt
         on attempt.workspace_id = node.workspace_id
        and attempt.node_run_id = node.id
        and attempt.id = node.current_attempt_id
        and attempt.attempt_number = node.current_attempt_number
       where node.workspace_id = $1 and node.workflow_run_id = $2
         and ($3::varchar[] is null or node.node_id = any($3::varchar[]))
         and (node.status = 'succeeded' or
              (node.status in ('running','waiting') and attempt.status = 'succeeded'))
       order by node.invocation_key`,
          [input.workspaceId, input.runId, input.nodeIds ?? null],
        );
  return {
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
