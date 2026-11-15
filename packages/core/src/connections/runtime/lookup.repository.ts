import { and, eq } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import { connectionSecretVersions } from '@pertexo/database/schema';

import { sealedFields } from '../connections.repository.js';

export async function readSealedSecret(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  secretVersionId: string,
) {
  const [row] = await drizzle(client)
    .select(sealedFields)
    .from(connectionSecretVersions)
    .where(
      and(
        eq(connectionSecretVersions.workspaceId, workspaceId),
        eq(connectionSecretVersions.connectionId, connectionId),
        eq(connectionSecretVersions.id, secretVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}
