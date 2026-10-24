import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { bindResourcePredicate } from '../../../tenant-access/resources/scope.queries.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../../../tenant-access/resources/connections/scope.js';
import { readFolderScope } from '../../../tenant-access/resources/facts.queries.js';
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
import { WorkflowPromotionError } from '../contract.js';

type ConnectionMetadata = Readonly<{
  id: string;
  name: string;
  normalized_name: string;
  provider_key: string;
  auth_type: string;
}>;
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
    const workflow = (
      await client.query<{ name: string }>(
        "select name from app.workflows where workspace_id=$1 and id=$2 and lifecycle_status='active' for share",
        [workspaceId, selection.workflowId],
      )
    ).rows[0];
    const version = (
      await client.query<{
        version_number: number;
        checksum: string;
        graph_json: unknown;
      }>(
        'select version_number,checksum,graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
        [workspaceId, selection.workflowId, selection.versionId],
      )
    ).rows[0];
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
  const connectionParameters: unknown[] = [workspaceId, connectionIds];
  const permitted = bindResourcePredicate(
    connectionScopeSql(
      connectionScope({ workspaceId, actorId }, scope.role, 'connection:read'),
    ),
    connectionParameters,
  );
  const connections =
    connectionIds.length === 0
      ? []
      : (
          await client.query<ConnectionMetadata>(
            `select id,name,lower(name) normalized_name,provider_key,auth_type from app.connections connection where workspace_id=$1 and id=any($2::uuid[]) and ${permitted} order by id for share`,
            connectionParameters,
          )
        ).rows;
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
