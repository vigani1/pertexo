import {
  readSourceConnections,
  readSourceVersion,
} from './source.repository.js';
import { connectionScope } from '../../../shared/resources/connection-scope.repository.js';
import {
  parseWorkflowGraphDraft,
  workflowNodes,
} from '@pertexo/workflow-model';
import type { WorkflowPromotionPreviewRequest } from '@pertexo/contracts';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { readFolderScope } from '../../../shared/folder-access-facts.repository.js';
import { workflowAccessible } from '../../../shared/resources/workflow-access.repository.js';
import type { PoolClient } from 'pg';
import { isDataTableDefinition, type DataTableConfig } from '@pertexo/node-sdk';
import { readTablesByNames } from '../../../data-tables/table-lookups.repository.js';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import type { PromotionGraphBudget } from './graph.js';
import { WorkflowPromotionError } from '../workflow-promotion.errors.js';
import type {
  PromotionSource,
  PromotionSourceSet,
} from './source.repository.js';

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
    const { workflow, version } = await readSourceVersion(
      client,
      workspaceId,
      selection,
    );
    if (workflow === undefined || version === undefined)
      throw new WorkflowNotFoundError(
        'A selected published workflow version is unavailable.',
      );
    const graph = decodeStoredValue(() =>
      parseWorkflowGraphDraft(version.graph_json),
    );
    budget.add(graph);
    workflows.push({
      ...selection,
      name: workflow.name,
      versionNumber: version.version_number,
      checksum: version.checksum,
      graph,
    });
  }
  const nodes = workflows.flatMap(({ graph }) => [...workflowNodes(graph)]);
  const connectionIds = [
    ...new Set(nodes.flatMap((node) => Object.values(node.connectionRefs))),
  ].sort();
  if (connectionIds.length > REVIEWED_CONNECTION_MAX)
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

/** Distinct connections one promotion review reads. */
const REVIEWED_CONNECTION_MAX = 1000;
