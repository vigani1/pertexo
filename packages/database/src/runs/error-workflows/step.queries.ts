import { workflowVersions } from '../../schema/authoring/workflows.js';
import { nodeAttempts, nodeRuns } from '../../schema/runs/execution.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
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
  const db = drizzle(client);
  const graph = sql`(${workflowGraphStepSql(sql`${workflowVersions.graphJson}`, sql`${input.nodeId}::text`)}) as graph_node`;
  const [row] = await db
    .select({
      name: sql<string | null>`graph_node.value->>'label'`,
      node_type: sql<string | null>`graph_node.value->'definition'->>'key'`,
      error_kind: nodeAttempts.executorErrorKind,
      safe_error_code: nodeRuns.safeErrorCode,
    })
    .from(workflowVersions)
    .leftJoinLateral(graph, sql`true`)
    .leftJoin(
      nodeRuns,
      and(
        eq(nodeRuns.workspaceId, workflowVersions.workspaceId),
        eq(nodeRuns.workflowRunId, input.runId),
        eq(nodeRuns.invocationKey, input.invocationKey),
      ),
    )
    .leftJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
        eq(nodeAttempts.attemptNumber, nodeRuns.currentAttemptNumber),
      ),
    )
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.id, input.workflowVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
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
