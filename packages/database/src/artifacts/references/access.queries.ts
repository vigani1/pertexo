import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { artifacts } from '../../schema/transport.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { readTransactionFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';
import { artifactReferenceOwnersSql } from './owners.queries.js';

/** Check stored sources before the caller persists a new reference. */
export async function visibleTransactionArtifactIds(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  actor: ResourceActor,
  ids: readonly string[],
  workspaceStatuses?: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const scope = await readTransactionFolderScope(
    transaction,
    actor,
    undefined,
    workspaceStatuses,
  );
  if (!scope.permits(null, 'workflow:read')) return new Set();
  const owners = artifactReferenceOwnersSql(
    sql`${actor.workspaceId}`,
    sql`${artifacts.id}`,
    (column) => workflowScopeSql(scope, column),
  );
  const result = await transaction.db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, actor.workspaceId),
        inArray(artifacts.id, [...ids]),
        or(eq(artifacts.purpose, 'user-upload'), owners),
      ),
    );
  return new Set(result.map(({ id }) => id));
}
export function visibleArtifactIds(
  client: PoolClient,
  actor: ResourceActor,
  ids: readonly string[],
  workspaceStatuses?: readonly string[],
) {
  return visibleTransactionArtifactIds(
    { db: drizzle(client) },
    actor,
    ids,
    workspaceStatuses,
  );
}
