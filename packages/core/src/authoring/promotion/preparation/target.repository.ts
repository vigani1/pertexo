import { asc, eq } from 'drizzle-orm';
import {
  workspaceDataTables,
  workspaceVariables,
} from '@pertexo/database/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { readTablesByNames } from '../../../data-tables/table-lookups.repository.js';

export function readTargetTables(
  client: PoolClient,
  workspaceId: string,
  names: readonly string[],
) {
  return readTablesByNames(drizzle(client), workspaceId, [...names]).catch(
    rethrowQueryFailure,
  );
}

/** The target's table schemas, share-locked, and its variable set revision. */
export async function readTargetFingerprintFacts(
  client: PoolClient,
  workspaceId: string,
) {
  const db = drizzle(client);
  const tableSchemas = await db
    .select({
      id: workspaceDataTables.id,
      name: workspaceDataTables.name,
      columns_json: workspaceDataTables.columns,
      key_column: workspaceDataTables.keyColumn,
      revision: workspaceDataTables.revision,
      has_removed_columns: workspaceDataTables.hasRemovedColumns,
    })
    .from(workspaceDataTables)
    .where(eq(workspaceDataTables.workspaceId, workspaceId))
    .orderBy(asc(workspaceDataTables.id))
    .for('share')
    .catch(rethrowQueryFailure);
  const [variables] = await db
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return { tableSchemas, variableHead: variables?.revision ?? 0 };
}
