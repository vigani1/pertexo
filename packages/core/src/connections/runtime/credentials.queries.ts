import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  connections,
  connectionSecretVersions,
} from '@pertexo/database/schema';
import { connectionFields, sealedFields } from '../records.queries.js';
/** The current pointer and composite FK fix which immutable secret belongs to this record. */
export function connectionSecrets(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      connection: connectionFields,
      sealed: sealedFields,
      secretVersionId: connectionSecretVersions.id,
      healthRevision: sql<string>`${connections.healthRevision}::text`,
    })
    .from(connections)
    .innerJoin(
      connectionSecretVersions,
      and(
        eq(connectionSecretVersions.workspaceId, connections.workspaceId),
        eq(connectionSecretVersions.connectionId, connections.id),
        eq(connectionSecretVersions.id, connections.currentSecretVersionId),
      ),
    );
}
