import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connections, workspaces } from '@pertexo/database/schema';

import type {
  AssertConnectionSecretCurrentInput,
  ResolveConnectionSecretInput,
} from '../connection.types.js';
import { connectionSecrets } from './credentials.repository.js';

/** The active provider connection's current sealed secret, in an active workspace. */
export async function readUsableSecret(
  client: PoolClient,
  input: ResolveConnectionSecretInput,
) {
  const { workspaceId, connectionId } = input;
  const [row] = await connectionSecrets(drizzle(client))
    .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
        eq(connections.providerKey, input.expectedProviderKey),
        eq(connections.status, 'active'),
        eq(workspaces.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/** Whether the secret the worker holds is still the active connection's current one. */
export async function secretStillCurrent(
  client: PoolClient,
  input: AssertConnectionSecretCurrentInput,
): Promise<boolean> {
  const { workspaceId } = input;
  const result = await drizzle(client)
    .select({ id: connections.id })
    .from(connections)
    .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, input.connectionId),
        eq(connections.providerKey, input.expectedProviderKey),
        eq(connections.authType, sql`${input.expectedAuthType}`),
        eq(connections.currentSecretVersionId, input.secretVersionId),
        eq(connections.status, 'active'),
        eq(workspaces.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  return result.length === 1;
}
