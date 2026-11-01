import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionOAuth2Authorizations,
  connectionOAuth2Clients,
  connectionOAuth2Tokens,
} from '@pertexo/database/schema';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  type ConnectionRecord,
} from '../contract.js';

/** A connection's client for one secret version: inserted beside that version. */
export async function insertOAuth2Client(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    secretVersionId: string;
    settings: unknown;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(connectionOAuth2Clients)
    .values(input)
    .catch(rethrowQueryFailure);
}

/** Replace and revoke drop what was granted; the sealed secret stays with its version. */
export async function deleteOAuth2Grant(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(connectionOAuth2Tokens)
    .where(
      and(
        eq(connectionOAuth2Tokens.workspaceId, workspaceId),
        eq(connectionOAuth2Tokens.connectionId, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(connectionOAuth2Authorizations)
    .where(
      and(
        eq(connectionOAuth2Authorizations.workspaceId, workspaceId),
        eq(connectionOAuth2Authorizations.connectionId, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/**
 * Deletion was requested, so no connection here stays active: a refresh token
 * doesn't wait out the recovery window, and a restored workspace reconnects.
 */
export async function deleteWorkspaceOAuth2Grants(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(connectionOAuth2Tokens)
    .where(eq(connectionOAuth2Tokens.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  await db
    .delete(connectionOAuth2Authorizations)
    .where(eq(connectionOAuth2Authorizations.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
}

/**
 * Adds what an OAuth2 connection answers with, read in the caller's transaction
 * so a status and its grant can't come from two different moments.
 */
export async function withOAuth2Facts(
  client: PoolClient,
  workspaceId: string,
  records: readonly ConnectionRecord[],
): Promise<readonly ConnectionRecord[]> {
  const ids = records
    .filter(({ authType }) => authType === CONNECTION_AUTH_TYPE.oauth2)
    .map(({ id }) => id);
  if (ids.length === 0) return records;
  const facts = await drizzle(client)
    .select({
      connectionId: connections.id,
      settings: connectionOAuth2Clients.settings,
      authorizedAt: connectionOAuth2Tokens.authorizedAt,
      accessTokenExpiresAt: connectionOAuth2Tokens.accessTokenExpiresAt,
      renewable: connectionOAuth2Tokens.renewable,
    })
    .from(connections)
    .innerJoin(
      connectionOAuth2Clients,
      and(
        eq(connectionOAuth2Clients.workspaceId, connections.workspaceId),
        eq(connectionOAuth2Clients.connectionId, connections.id),
        eq(
          connectionOAuth2Clients.secretVersionId,
          connections.currentSecretVersionId,
        ),
      ),
    )
    .leftJoin(
      connectionOAuth2Tokens,
      and(
        eq(connectionOAuth2Tokens.workspaceId, connections.workspaceId),
        eq(connectionOAuth2Tokens.connectionId, connections.id),
        eq(
          connectionOAuth2Tokens.secretVersionId,
          connections.currentSecretVersionId,
        ),
      ),
    )
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        inArray(connections.id, ids),
      ),
    )
    .catch(rethrowQueryFailure);
  const byConnection = new Map(facts.map((row) => [row.connectionId, row]));
  return records.map((record) => {
    const fact = byConnection.get(record.id);
    if (fact === undefined) return record;
    return Object.freeze({
      ...record,
      oauth2: Object.freeze({
        settings: fact.settings,
        grant:
          record.status !== CONNECTION_STATUS.active ||
          fact.authorizedAt === null ||
          fact.renewable === null
            ? null
            : Object.freeze({
                authorizedAt: fact.authorizedAt,
                accessTokenExpiresAt: fact.accessTokenExpiresAt,
                renewable: fact.renewable,
              }),
      }),
    });
  });
}

export async function withOneOAuth2Fact(
  client: PoolClient,
  workspaceId: string,
  record: ConnectionRecord,
): Promise<ConnectionRecord> {
  const [hydrated] = await withOAuth2Facts(client, workspaceId, [record]);
  return hydrated ?? record;
}
