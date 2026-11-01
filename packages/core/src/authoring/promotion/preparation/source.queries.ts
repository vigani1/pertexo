import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflows as authoringWorkflows,
  workflowVersions,
  connections as storedConnections,
} from '@pertexo/database/schema';
import type { ConnectionScope } from '../../../tenant-access/resources/connections/scope.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../../../tenant-access/resources/connections/scope.js';
import { readFolderScope } from '../../../shared/facts.queries.js';
import { workflowAccessible } from '../../../tenant-access/resources/workflows.queries.js';
import type { PoolClient } from 'pg';
import type { WorkflowPromotionPreviewRequest } from '@pertexo/contracts';
import {
  parseWorkflowGraphDraft,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { isDataTableDefinition, type DataTableConfig } from '@pertexo/node-sdk';
import { readTablesByNames } from '../../../data-tables/definitions.queries.js';
import type { DataTableDefinition } from '../../../data-tables/contract.js';
import { WorkflowNotFoundError } from '../../workflows/errors.js';
import { promotionNodes, type PromotionGraphBudget } from './graph.js';
import { WorkflowPromotionError } from '../errors.js';

export const promotionConnection = alias(storedConnections, 'connection');
export const promotionConnectionProjection = {
  id: promotionConnection.id,
  name: promotionConnection.name,
  normalized_name: sql<string>`lower(${promotionConnection.name})`,
  provider_key: promotionConnection.providerKey,
  auth_type: promotionConnection.authType,
};
type ConnectionMetadata = Awaited<
  ReturnType<typeof readSourceConnections>
>[number];
export type PromotionSource = Readonly<{
  workflowId: string;
  versionId: string;
  name: string;
  versionNumber: number;
  checksum: string;
  graph: WorkflowGraph;
}>;
export type PromotionSourceSet = Readonly<{
  workflows: readonly PromotionSource[];
  connections: readonly ConnectionMetadata[];
  tables: readonly DataTableDefinition[];
}>;
export async function readPromotionSources(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    selections,
    budget,
  }: Readonly<{
    actorId: string;
    selections: WorkflowPromotionPreviewRequest['selections'];
    budget: PromotionGraphBudget;
  }>,
): Promise<PromotionSourceSet> {
  const workflows: PromotionSource[] = [];
  const scope = await readFolderScope(client, { workspaceId, actorId });
  for (const selection of [...selections].sort((a, b) =>
    a.workflowId < b.workflowId ? -1 : 1,
  )) {
    if (
      !(await workflowAccessible(client, scope, {
        workspaceId,
        workflowId: selection.workflowId,
      }))
    )
      throw new WorkflowNotFoundError(
        'A selected published workflow version is unavailable.',
      );
    const db = drizzle(client);
    const [workflow] = await db
      .select({ name: authoringWorkflows.name })
      .from(authoringWorkflows)
      .where(
        and(
          eq(authoringWorkflows.workspaceId, workspaceId),
          eq(authoringWorkflows.id, selection.workflowId),
          eq(authoringWorkflows.lifecycleStatus, 'active'),
        ),
      )
      .for('share')
      .catch(rethrowQueryFailure);
    const [version] = await db
      .select({
        version_number: workflowVersions.versionNumber,
        checksum: workflowVersions.checksum,
        graph_json: workflowVersions.graphJson,
      })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workspaceId, workspaceId),
          eq(workflowVersions.workflowId, selection.workflowId),
          eq(workflowVersions.id, selection.versionId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (workflow === undefined || version === undefined)
      throw new WorkflowNotFoundError(
        'A selected published workflow version is unavailable.',
      );
    const graph = parseWorkflowGraphDraft(version.graph_json);
    budget.add(graph);
    workflows.push({
      ...selection,
      name: workflow.name,
      versionNumber: version.version_number,
      checksum: version.checksum,
      graph,
    });
  }
  const nodes = workflows.flatMap(({ graph }) => [...promotionNodes(graph)]);
  const connectionIds = [
    ...new Set(nodes.flatMap((node) => Object.values(node.connectionRefs))),
  ].sort();
  if (connectionIds.length > 1000)
    throw new WorkflowPromotionError(
      'limit',
      'Select fewer workflows to review their connections.',
    );
  const connections = await readSourceConnections(client, {
    workspaceId,
    scope: connectionScope(
      { workspaceId, actorId },
      scope.role,
      'connection:read',
    ),
    connectionIds,
  });
  const tableNames = [
    ...new Set(
      nodes
        .filter((node) => isDataTableDefinition(node.definition))
        .map((node) => (node.config as DataTableConfig).table),
    ),
  ];
  const tables = await readTablesByNames(
    drizzle(client),
    workspaceId,
    tableNames,
  ).catch(rethrowQueryFailure);
  return { workflows, connections, tables };
}

function readSourceConnections(
  client: PoolClient,
  {
    workspaceId,
    scope,
    connectionIds,
  }: Readonly<{
    workspaceId: string;
    scope: ConnectionScope;
    connectionIds: string[];
  }>,
) {
  if (connectionIds.length === 0) return Promise.resolve([]);
  return drizzle(client)
    .select(promotionConnectionProjection)
    .from(promotionConnection)
    .where(
      and(
        eq(promotionConnection.workspaceId, workspaceId),
        inArray(promotionConnection.id, connectionIds),
        connectionScopeSql(scope, promotionConnection),
      ),
    )
    .orderBy(asc(promotionConnection.id))
    .for('share')
    .catch(rethrowQueryFailure);
}
