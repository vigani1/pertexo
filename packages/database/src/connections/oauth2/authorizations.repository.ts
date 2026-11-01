import { rolesForCapability } from '@pertexo/workflow-model';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  connectionEvents,
  connections,
  connectionSecretVersions,
} from '../../schema/connections.js';
import {
  connectionOAuth2Authorizations as authorizations,
  connectionOAuth2Clients,
  connectionOAuth2Tokens as tokens,
} from '../../schema/oauth2-connections.js';
import { workspaces } from '../../schema/foundation.js';
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
import {
  connectionFields,
  sealedFields,
  selectConnection,
} from '../records.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import { withOneOAuth2Fact } from './clients.repository.js';
import type {
  ConsumedOAuth2Authorization,
  IssuedOAuth2Tokens,
  OAuth2ClientRecord,
  OAuth2ConsentDatabase,
} from './contract.js';
import {
  expiryOf,
  readEarlierTokens,
  sealedColumns,
} from './tokens.repository.js';

export function createOAuth2AuthorizationPersistence(
  pool: Pool,
): OAuth2ConsentDatabase {
  return Object.freeze({
    readOAuth2Client: (input) => readClient(pool, input),
    startOAuth2Authorization: (input) => startAuthorization(pool, input),
    consumeOAuth2Authorization: (input) => consumeAuthorization(pool, input),
    readOAuth2EarlierTokens: (input) => readEarlierTokens(pool, input),
    authorizeOAuth2Connection: (input) => authorize(pool, input),
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

async function replaceTokenRow(
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

/**
 * Consent or a server-to-server start succeeded. It answers for the settings it
 * ran with: replaced or revoked since then, the new tokens are discarded.
 */
async function authorize(
  pool: Pool,
  input: Parameters<OAuth2ConsentDatabase['authorizeOAuth2Connection']>[0],
): ReturnType<OAuth2ConsentDatabase['authorizeOAuth2Connection']> {
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId: undefined,
    operation: async (client, workspaceId) => {
      // Deletion may have been requested during the exchange. Shared, so it can't
      // commit between this check and the insert and leave tokens behind.
      const [workspace] = await drizzle(client)
        .select({ status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('share')
        .catch(rethrowQueryFailure);
      if (workspace?.status !== 'active') return null;
      const current = await selectConnection(
        client,
        workspaceId,
        input.connectionId,
        { lock: true },
      );
      if (
        current === null ||
        current.status === CONNECTION_STATUS.revoked ||
        current.currentSecretVersionId !== input.secretVersionId
      )
        return null;
      await replaceTokenRow(client, workspaceId, input);
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
            eq(connections.id, input.connectionId),
          ),
        )
        .returning(connectionFields)
        .catch(rethrowQueryFailure);
      if (row === undefined)
        throw new Error('OAuth2 authorization returned no connection');
      const metadata = { secretVersionId: input.secretVersionId };
      await db
        .insert(connectionEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          connectionId: input.connectionId,
          eventType: 'connection.oauth2_authorized',
          actorKind: 'user',
          actorId: input.actorId,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata,
        })
        .catch(rethrowQueryFailure);
      await appendAuditFact(client, {
        workspaceId,
        actorId: input.actorId,
        action: 'connection.oauth2_authorized',
        targetType: 'connection',
        targetId: input.connectionId,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        metadata,
      });
      return withOneOAuth2Fact(client, workspaceId, Object.freeze(row));
    },
  });
}
