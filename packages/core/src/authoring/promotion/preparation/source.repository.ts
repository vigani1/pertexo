import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflows as authoringWorkflows,
  workflowVersions,
  connections as storedConnections,
} from '@pertexo/database/schema';
import type { ConnectionScope } from '../../../shared/resources/connection-scope.repository.js';
import { connectionScopeSql } from '../../../shared/resources/connection-scope.repository.js';
import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { DataTableDefinition } from '@pertexo/contracts';

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

export function readSourceConnections(
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

/** The active source workflow, share-locked, and the selected version of it. */
export async function readSourceVersion(
  client: PoolClient,
  workspaceId: string,
  selection: Readonly<{ workflowId: string; versionId: string }>,
) {
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
  return { workflow, version };
}
