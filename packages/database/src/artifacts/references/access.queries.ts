import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { readTransactionFolderScope } from '../../tenant-access/resources/facts.js';
import { workflowScopeSql } from '../../tenant-access/resources/query-scope.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';
import { artifactReferenceOwnersSql } from './owners.queries.js';

/** Check stored sources before the caller persists a new reference. */
export async function visibleTransactionArtifactIds(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  actor: ResourceActor,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const scope = await readTransactionFolderScope(transaction, actor);
  if (!scope.permits(null, 'workflow:read')) return new Set();
  const owners = artifactReferenceOwnersSql(
    sql`${actor.workspaceId}`,
    sql`candidate.id`,
    (column) => workflowScopeSql(scope, column),
  );
  const result = await transaction.db.execute<{
    id: string;
  }>(sql`select candidate.id from app.artifacts candidate
    where candidate.workspace_id=${actor.workspaceId} and candidate.id=any(${sql.param(ids)}::uuid[])
      and (candidate.purpose='user-upload' or (${owners}))`);
  return new Set(result.rows.map(({ id }) => id));
}
export function visibleArtifactIds(
  client: PoolClient,
  actor: ResourceActor,
  ids: readonly string[],
) {
  return visibleTransactionArtifactIds({ db: drizzle(client) }, actor, ids);
}
