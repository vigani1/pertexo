import {
  connectionScopeSql,
  type ConnectionScope,
} from '../../../tenant-access/resources/connections/scope.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { promotionConnection } from './source.queries.js';
import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  workflowVariableSources,
  inspectWorkflowVariableSource,
} from '@pertexo/workflow-model/server';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { lockWorkspaceVariableNames } from '../../../variables/head.queries.js';
import { dataTableReferenceIssues } from '../../../data-tables/columns/references.queries.js';
import { promotionNodes } from './graph.js';

export async function inspectPromotionRequirements(
  client: PoolClient,
  workspaceId: string,
  {
    workflowId,
    graph,
    scope,
  }: Readonly<{
    workflowId: string;
    graph: WorkflowGraph;
    scope: ConnectionScope;
  }>,
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
    const visible = connectionScopeSql(scope, promotionConnection);
    const rows = await drizzle(client)
      .select({
        id: promotionConnection.id,
        name: sql<
          string | null
        >`case when ${visible} then ${promotionConnection.name} else null end`,
        status: promotionConnection.status,
      })
      .from(promotionConnection)
      .where(
        and(
          eq(promotionConnection.workspaceId, workspaceId),
          inArray(promotionConnection.id, ids),
        ),
      )
      .orderBy(asc(promotionConnection.id))
      .for('share')
      .catch(rethrowQueryFailure);
    for (const id of ids) {
      const connection = rows.find((row) => row.id === id);
      report.push({
        workflowId,
        kind: 'connection',
        status: connection?.status === 'active' ? 'ready' : 'missing',
        name: connection?.name ?? 'Published child connection',
        detail: connectionRequirementDetail(connection),
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

function connectionRequirementDetail(
  connection: Readonly<{ name: string | null; status: string }> | undefined,
): string {
  if (connection?.status === 'active') {
    if (connection.name === null) {
      return 'Uses the published child’s accepted connection binding.';
    }
    return 'Uses this target connection.';
  }
  return 'A retained Call dependency needs an active target connection.';
}
