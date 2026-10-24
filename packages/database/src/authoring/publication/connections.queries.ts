import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { connections } from '../../schema/connections.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type {
  GraphValidationIssue,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import { CONNECTION_STATUS } from '../../connections/contract.js';
import {
  workflowConnectionReferences,
  connectionReferenceIds,
} from '../../tenant-access/resources/connections/bindings.queries.js';
import {
  readConnectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
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
  const connection = alias(connections, 'connection');
  const permitted = connectionScopeSql(
    await readConnectionScope(client, actor, 'connection:use'),
    sql`${connection}`,
  );
  const rows =
    ids.length === 0
      ? []
      : await drizzle(client)
          .select({ id: connection.id, status: connection.status })
          .from(connection)
          .where(
            and(
              eq(connection.workspaceId, actor.workspaceId),
              inArray(connection.id, ids),
              permitted,
            ),
          )
          .orderBy(asc(connection.id))
          .for('share')
          .catch(rethrowQueryFailure);
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
