import type { PoolClient } from 'pg';
import type {
  GraphValidationIssue,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import { CONNECTION_STATUS } from '../../connections/records.queries.js';
import {
  workflowConnectionReferences,
  connectionReferenceIds,
} from '../../tenant-access/resources/connections/bindings.js';
import {
  readConnectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';

/** Permission applies to every binding; only enabled steps require a non-revoked secret. */
export async function connectionReferenceIssues(
  client: PoolClient,
  actor: ResourceActor,
  graph: WorkflowGraph,
): Promise<readonly GraphValidationIssue[]> {
  const references = workflowConnectionReferences(graph);
  if (references.length === 0) return [];
  const ids = connectionReferenceIds(references);
  const parameters: unknown[] = [actor.workspaceId, ids];
  const permitted = bindResourcePredicate(
    connectionScopeSql(
      await readConnectionScope(client, actor, 'connection:use'),
    ),
    parameters,
  );
  const rows =
    ids.length === 0
      ? []
      : (
          await client.query<{ id: string; status: string }>(
            `select connection.id,connection.status from app.connections connection where connection.workspace_id=$1 and connection.id=any($2::uuid[]) and ${permitted} order by connection.id for share`,
            parameters,
          )
        ).rows;
  const available = new Map(rows.map((row) => [row.id, row.status]));
  return references
    .filter((reference) => {
      const status = available.get(reference.id.toLowerCase());
      return (
        status === undefined ||
        (reference.enabled && status === CONNECTION_STATUS.revoked)
      );
    })
    .map((reference) => ({
      code: 'invalid_graph',
      path: reference.path,
      message:
        'This connection is unavailable. Choose a connection you can use.',
    }));
}
