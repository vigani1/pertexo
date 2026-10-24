import type { PoolClient } from 'pg';
import { workflowGraphStepSql } from '../queries/execution/graph-step.js';
import {
  workflowFailureClassificationSchema,
  type WorkflowErrorInput,
} from '@pertexo/workflow-model';

/** Only immutable authoring metadata and the writer's fixed classification are read. */
export async function readErrorWorkflowStep(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowVersionId: string;
    invocationKey: string;
    nodeId: string;
  }>,
): Promise<Omit<NonNullable<WorkflowErrorInput['failedStep']>, 'id'>> {
  const found = await client.query<{
    name: string | null;
    node_type: string | null;
    error_kind: string | null;
    safe_error_code: string | null;
  }>(
    `select graph_node.value->>'label' name,graph_node.value->'definition'->>'key' node_type,
    attempt.executor_error_kind error_kind,node.safe_error_code
    from app.workflow_versions version
    left join lateral (${workflowGraphStepSql('version.graph_json', '$5::text')}) graph_node on true
    left join app.node_runs node on node.workspace_id=version.workspace_id and node.workflow_run_id=$3 and node.invocation_key=$4
    left join app.node_attempts attempt on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id and attempt.attempt_number=node.current_attempt_number
    where version.workspace_id=$1 and version.id=$2`,
    [
      input.workspaceId,
      input.workflowVersionId,
      input.runId,
      input.invocationKey,
      input.nodeId,
    ],
  );
  const row = found.rows[0];
  const classification = workflowFailureClassificationSchema.safeParse({
    errorKind: row?.error_kind ?? 'human_task',
    safeErrorCode: row?.safe_error_code,
  });
  const name = row?.name?.trim();
  return {
    name: name === '' ? input.nodeId : (name ?? input.nodeId),
    nodeType: row?.node_type ?? null,
    errorKind: classification.success ? classification.data.errorKind : null,
    safeErrorCode: classification.success
      ? classification.data.safeErrorCode
      : null,
  };
}
