import { nodeRuns, workflowVersions } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { and, eq, sql } from 'drizzle-orm';
import { workflowGraphStepSql } from './execution/graph-step.repository.js';
import type { WorkflowRunReadRecord } from '../commands/workflow-run-records.repository.js';

const EXPLANATION_RECENT_STEPS = 20;
const EXPLANATION_LABEL_CHARACTERS = 120;

export function readExplanationSteps(
  transaction: WorkspaceTransaction,
  run: WorkflowRunReadRecord,
) {
  const graph = sql`lateral (${workflowGraphStepSql(sql`${workflowVersions.graphJson}`, sql`${nodeRuns.nodeId}`)}) graph_node`;
  return transaction.db
    .select({
      id: nodeRuns.nodeId,
      label: sql<
        string | null
      >`left(nullif(btrim(graph_node.value->>'label'),''),${EXPLANATION_LABEL_CHARACTERS})`,
      key: sql<string | null>`graph_node.value->'definition'->>'key'`,
      status: nodeRuns.status,
      version: workflowVersions.versionNumber,
    })
    .from(nodeRuns)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.id, run.workflowVersionId),
      ),
    )
    .leftJoin(graph, sql`true`)
    .where(
      and(
        eq(nodeRuns.workspaceId, transaction.workspaceId),
        eq(nodeRuns.workflowRunId, run.id),
      ),
    )
    .orderBy(
      sql`${nodeRuns.completedAt} desc nulls last`,
      sql`${nodeRuns.id} desc`,
    )
    .limit(EXPLANATION_RECENT_STEPS);
}
