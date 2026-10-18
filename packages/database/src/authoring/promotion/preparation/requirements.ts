import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  workflowVariableSources,
  inspectWorkflowVariableSource,
} from '@pertexo/workflow-model/server';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { lockWorkspaceVariableNames } from '../../../variables/read.js';
import { dataTableReferenceIssues } from '../../../data-tables/columns/references.js';
import { promotionNodes } from './graph.js';

export async function inspectPromotionRequirements(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
): Promise<WorkflowPromotionRequirement[]> {
  const report: WorkflowPromotionRequirement[] = [];
  const variableNames = await lockWorkspaceVariableNames(client, workspaceId);
  for (const source of workflowVariableSources(graph)) {
    const { reference, incomplete } = inspectWorkflowVariableSource(source);
    if (incomplete)
      report.push({
        workflowId,
        kind: 'validation',
        status: 'incompatible',
        name: source.label,
        detail:
          'Variable usage could not be inspected. Correct this expression before promotion.',
      });
    if (reference === null) continue;
    for (const name of reference.names)
      report.push({
        workflowId,
        kind: 'variable',
        status: variableNames.includes(name) ? 'ready' : 'missing',
        name,
        detail: variableNames.includes(name)
          ? 'Uses the target workspace value.'
          : 'Create this variable in the target workspace.',
      });
    if (reference.dynamic)
      report.push({
        workflowId,
        kind: 'variable',
        status: 'warning',
        name: source.label,
        detail:
          'This expression selects variables dynamically. Verify its names against the target workspace.',
      });
  }
  const ids = [
    ...new Set(
      [...promotionNodes(graph)].flatMap((node) =>
        Object.values(node.connectionRefs),
      ),
    ),
  ].sort();
  if (ids.length > 0) {
    const rows = (
      await client.query<{ id: string; name: string; status: string }>(
        'select id,name,status from app.connections where workspace_id=$1 and id=any($2::uuid[]) order by id for share',
        [workspaceId, ids],
      )
    ).rows;
    for (const id of ids) {
      const connection = rows.find((row) => row.id === id);
      report.push({
        workflowId,
        kind: 'connection',
        status: connection?.status === 'active' ? 'ready' : 'missing',
        name: connection?.name ?? 'Unavailable connection',
        detail:
          connection?.status === 'active'
            ? 'Uses this target connection.'
            : 'A retained Call dependency needs an active target connection.',
      });
    }
  }
  for (const issue of await dataTableReferenceIssues(
    client,
    workspaceId,
    graph,
  ))
    report.push({
      workflowId,
      kind: 'table',
      status: 'incompatible',
      name: 'Table columns',
      detail: issue.message.slice(0, 512),
    });
  return report;
}
