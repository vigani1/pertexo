import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { artifacts } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { readTransactionFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';
import { ARTIFACT_UPLOAD_PURPOSE } from '../contract.js';
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
        or(eq(artifacts.purpose, ARTIFACT_UPLOAD_PURPOSE), owners),
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
