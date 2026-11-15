import { drizzle } from 'drizzle-orm/node-postgres';

import type { PoolClient } from 'pg';

import {
  isUniqueConstraintFailure,
  postgresFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { connections } from '@pertexo/database/schema';

import type { CreateConnectionInput } from '../connection.types.js';
import { healthOfNewSecret } from '../health/rules.js';

import { connectionFields } from '../connections.repository.js';

/** A taken active name for this provider reads as `duplicate_name`. */
export async function insertConnection(
  client: PoolClient,
  input: CreateConnectionInput,
) {
  const { workspaceId, actorId, connectionId, secretVersionId } = input;
  const { providerKey, name, authType } = input;
  const inserted = await drizzle(client)
    .insert(connections)
    .values({
      id: connectionId,
      workspaceId,
      providerKey,
      name,
      authType,
      ...healthOfNewSecret(authType),
      currentSecretVersionId: secretVersionId,
      createdBy: actorId,
    })
    .returning(connectionFields)
    .catch((error: unknown) => {
      if (isDuplicateName(error)) return 'duplicate_name' as const;
      return rethrowQueryFailure(error);
    });
  if (inserted === 'duplicate_name') return { kind: 'duplicate_name' } as const;
  const [row] = inserted;
  if (row === undefined) throw new Error('Connection insert returned no row');
  return { kind: 'inserted', row: Object.freeze(row) } as const;
}

function isDuplicateName(error: unknown): boolean {
  return (
    isUniqueConstraintFailure(error) &&
    postgresFailure(error).constraint ===
      'connections_active_name_provider_unique'
  );
}
