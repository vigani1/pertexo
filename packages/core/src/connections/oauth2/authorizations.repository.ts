import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionSecretVersions,
  connectionOAuth2Authorizations as authorizations,
  connectionOAuth2Clients,
  connectionOAuth2Tokens as tokens,
  workspaces,
} from '@pertexo/database/schema';
import { CONNECTION_STATUS } from '@pertexo/workflow-model';
import { connectionFields, sealedFields } from '../connections.repository.js';
import type {
  ConsumeOAuth2AuthorizationInput,
  IssuedOAuth2Tokens,
  StartOAuth2AuthorizationInput,
} from './oauth2-grant.types.js';
import { expiryOf, sealedColumns } from './token-columns.repository.js';

export async function selectClient(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  secretVersionId: string,
) {
  const [row] = await drizzle(client)
    .select({
      settings: connectionOAuth2Clients.settings,
      clientSecret: sealedFields,
    })
    .from(connectionOAuth2Clients)
    .innerJoin(
      connectionSecretVersions,
      and(
        eq(
          connectionSecretVersions.workspaceId,
          connectionOAuth2Clients.workspaceId,
        ),
        eq(
          connectionSecretVersions.connectionId,
          connectionOAuth2Clients.connectionId,
        ),
        eq(
          connectionSecretVersions.id,
          connectionOAuth2Clients.secretVersionId,
        ),
      ),
    )
    .where(
      and(
        eq(connectionOAuth2Clients.workspaceId, workspaceId),
        eq(connectionOAuth2Clients.connectionId, connectionId),
        eq(connectionOAuth2Clients.secretVersionId, secretVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/** One pending consent per connection; a new start replaces the old one. */
export async function upsertAuthorization(
  client: PoolClient,
  input: StartOAuth2AuthorizationInput,
) {
  const { workspaceId } = input;
  const expiresAt = sql`clock_timestamp()+make_interval(secs=>${input.lifetimeSeconds}::double precision)`;
  const values = {
    stateDigest: input.stateDigest,
    bindingDigest: input.bindingDigest,
    startedBy: input.actorId,
    secretVersionId: input.secretVersionId,
    expiresAt,
  };
  const [row] = await drizzle(client)
    .insert(authorizations)
    .values({
      workspaceId,
      connectionId: input.connectionId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [authorizations.workspaceId, authorizations.connectionId],
      set: values,
    })
    .returning({ expiresAt: authorizations.expiresAt })
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('OAuth2 authorization returned no row');
  return Object.freeze(row);
}

/** Deletes and returns the live consent this state and binding hold, if any. */
export async function consumeAuthorizationState(
  client: PoolClient,
  input: ConsumeOAuth2AuthorizationInput,
) {
  const [row] = await drizzle(client)
    .delete(authorizations)
    .where(
      and(
        eq(authorizations.workspaceId, input.workspaceId),
        eq(authorizations.stateDigest, input.stateDigest),
        inArray(authorizations.bindingDigest, [...input.bindingDigests]),
        sql`${authorizations.expiresAt}>clock_timestamp()`,
      ),
    )
    .returning({
      connectionId: authorizations.connectionId,
      startedBy: authorizations.startedBy,
      secretVersionId: authorizations.secretVersionId,
    })
    .catch(rethrowQueryFailure);
  return row;
}

export async function replaceTokenRow(
  client: PoolClient,
  workspaceId: string,
  input: Readonly<{
    connectionId: string;
    secretVersionId: string;
    issued: IssuedOAuth2Tokens;
  }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(tokens)
    .where(
      and(
        eq(tokens.workspaceId, workspaceId),
        eq(tokens.connectionId, input.connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .insert(tokens)
    .values({
      id: input.issued.id,
      workspaceId,
      connectionId: input.connectionId,
      secretVersionId: input.secretVersionId,
      ...sealedColumns(input.issued),
      authorizedAt: sql`clock_timestamp()`,
      issuedAt: sql`clock_timestamp()`,
      accessTokenExpiresAt: expiryOf(input.issued),
      renewable: input.issued.renewable,
    })
    .catch(rethrowQueryFailure);
}

/** The workspace's status, share-locked so deletion can't commit past it. */
export async function shareLockWorkspaceStatus(
  client: PoolClient,
  workspaceId: string,
): Promise<string | undefined> {
  const [workspace] = await drizzle(client)
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  return workspace?.status;
}

export async function markOAuth2Authorized(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
) {
  const db = drizzle(client);
  const [row] = await db
    .update(connections)
    .set({
      status: CONNECTION_STATUS.active,
      lastErrorCode: null,
      lastHealthyAt: sql`clock_timestamp()`,
      healthRevision: sql`${connections.healthRevision}+1`,
      lastHealthTransitionAt: sql`clock_timestamp()`,
      lastHealthTransitionSource: 'rotation',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .returning(connectionFields)
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('OAuth2 authorization returned no connection');
  return Object.freeze(row);
}
