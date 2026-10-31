import { rolesForCapability } from '@pertexo/workflow-model';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { connectionSecretVersions } from '../../schema/connections.js';
import {
  connectionOAuth2Authorizations as authorizations,
  connectionOAuth2Clients,
} from '../../schema/oauth2-connections.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.queries.js';
import { requireConnectionManager } from '../authority.queries.js';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionNotOAuth2Error,
  ConnectionUnavailableError,
  type ConnectionRecord,
} from '../contract.js';
import { sealedFields, selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import { withOneOAuth2Fact } from './clients.repository.js';
import type {
  ConsumedOAuth2Authorization,
  OAuth2ClientRecord,
  OAuth2ConsentDatabase,
} from './contract.js';

export function createOAuth2AuthorizationPersistence(
  pool: Pool,
): Omit<OAuth2ConsentDatabase, 'authorizeOAuth2Connection'> {
  return Object.freeze({
    readOAuth2Client: (input) => readClient(pool, input),
    startOAuth2Authorization: (input) => startAuthorization(pool, input),
    consumeOAuth2Authorization: (input) => consumeAuthorization(pool, input),
  });
}

/** Only a connection that can still be connected may start consent. */
function requireConnectable(
  connection: ConnectionRecord | null,
): ConnectionRecord {
  if (connection === null)
    throw new ConnectionNotFoundError('Connection is not visible');
  if (connection.authType !== CONNECTION_AUTH_TYPE.oauth2)
    throw new ConnectionNotOAuth2Error('Connection does not use OAuth2');
  if (connection.status === CONNECTION_STATUS.revoked)
    throw new ConnectionUnavailableError('Connection is revoked');
  return connection;
}

async function selectClient(
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

async function readClient(
  pool: Pool,
  input: Parameters<OAuth2ConsentDatabase['readOAuth2Client']>[0],
): Promise<OAuth2ClientRecord> {
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId: input.actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionManager(client, workspaceId, input.actorId);
      const connection = requireConnectable(
        await selectConnection(client, workspaceId, input.connectionId),
      );
      const row = await selectClient(
        client,
        workspaceId,
        input.connectionId,
        connection.currentSecretVersionId,
      );
      if (row === undefined)
        throw new Error('OAuth2 connection has no client for its version');
      return Object.freeze({
        connection: await withOneOAuth2Fact(client, workspaceId, connection),
        settings: row.settings,
        clientSecret: row.clientSecret,
      });
    },
  });
}

async function startAuthorization(
  pool: Pool,
  input: Parameters<OAuth2ConsentDatabase['startOAuth2Authorization']>[0],
): Promise<Readonly<{ expiresAt: Date }>> {
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId: input.actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionManager(client, workspaceId, input.actorId);
      const connection = requireConnectable(
        await selectConnection(client, workspaceId, input.connectionId, {
          lock: true,
        }),
      );
      if (connection.currentSecretVersionId !== input.secretVersionId)
        throw new ConnectionUnavailableError('Connection settings changed');
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
    },
  });
}

/**
 * One statement decides who holds a state: two callbacks can't both consume it,
 * and a browser without the binding cookie leaves the row for the one that has it.
 */
async function consumeAuthorization(
  pool: Pool,
  input: Parameters<OAuth2ConsentDatabase['consumeOAuth2Authorization']>[0],
): Promise<ConsumedOAuth2Authorization> {
  if (input.bindingDigests.length === 0) return { kind: 'unknown' };
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client): Promise<ConsumedOAuth2Authorization> => {
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
      if (row === undefined) return { kind: 'unknown' };
      const refused = {
        kind: 'refused',
        connectionId: row.connectionId,
      } as const;
      try {
        await lockWorkspaceAuthority(
          client,
          input.workspaceId,
          row.startedBy,
          rolesForCapability('connection:manage'),
        );
      } catch (error: unknown) {
        if (error instanceof WorkspaceAccessDeniedError) return refused;
        throw error;
      }
      const connection = await selectConnection(
        client,
        input.workspaceId,
        row.connectionId,
      );
      if (
        connection === null ||
        connection.status === CONNECTION_STATUS.revoked ||
        connection.currentSecretVersionId !== row.secretVersionId
      )
        return refused;
      const stored = await selectClient(
        client,
        input.workspaceId,
        row.connectionId,
        row.secretVersionId,
      );
      if (stored === undefined) return refused;
      return Object.freeze({
        kind: 'consumed',
        connectionId: row.connectionId,
        startedBy: row.startedBy,
        secretVersionId: row.secretVersionId,
        settings: stored.settings,
        clientSecret: stored.clientSecret,
      });
    },
  );
}
