import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  connectionEvents,
  connections,
  connectionSecretVersions,
  workspaces,
  connectionOAuth2Clients as clients,
  connectionOAuth2Tokens as tokens,
} from '@pertexo/database/schema';
import { CONNECTION_AUTH_TYPE, CONNECTION_STATUS } from '../contract.js';
import { sealedFields, selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transaction.js';
import type {
  IssuedOAuth2Tokens,
  OAuth2ConsentDatabase,
  OAuth2GrantLossActor,
  OAuth2TokenRecord,
  OAuth2TokenStoreDatabase,
} from './contract.js';

const tokenFields = {
  id: tokens.id,
  kmsKeyReference: tokens.kmsKeyReference,
  encryptedDataKey: tokens.encryptedDataKey,
  ciphertext: tokens.ciphertext,
  nonce: tokens.nonce,
  tag: tokens.authTag,
  renewable: tokens.renewable,
  expiresAt: tokens.accessTokenExpiresAt,
  blockedUntil: tokens.refreshBlockedUntil,
  // Read here so a person's clock or a worker's never decides what is expired.
  now: sql<string>`clock_timestamp()`,
};

function tokenRecord(
  row: Readonly<{
    id: string;
    kmsKeyReference: string;
    encryptedDataKey: string;
    ciphertext: string;
    nonce: string;
    tag: string;
    renewable: boolean;
    expiresAt: Date | null;
    blockedUntil: Date | null;
    now: string;
  }>,
): OAuth2TokenRecord {
  return Object.freeze({
    id: row.id,
    sealed: Object.freeze({
      kmsKeyReference: row.kmsKeyReference,
      encryptedDataKey: row.encryptedDataKey,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      tag: row.tag,
    }),
    renewable: row.renewable,
    expiresAt: row.expiresAt,
    blockedUntil: row.blockedUntil,
    now: new Date(row.now),
  });
}

export const sealedColumns = (issued: IssuedOAuth2Tokens) => ({
  kmsKeyReference: issued.sealed.kmsKeyReference,
  encryptedDataKey: issued.sealed.encryptedDataKey,
  ciphertext: issued.sealed.ciphertext,
  nonce: issued.sealed.nonce,
  authTag: issued.sealed.tag,
});

/** Expiry counts from the commit, by database time. */
export const expiryOf = (issued: IssuedOAuth2Tokens) =>
  issued.expiresInSeconds === null
    ? null
    : sql`clock_timestamp()+make_interval(secs=>${issued.expiresInSeconds}::double precision)`;

export function createOAuth2TokenPersistence(
  pool: Pool,
): OAuth2TokenStoreDatabase {
  return Object.freeze({
    openOAuth2Grant: (input) => openGrant(pool, input),
    readOAuth2Token: async (input) => {
      const [row] = await withTenantScopedClient(
        pool,
        { workspaceId: input.workspaceId },
        (client) =>
          drizzle(client)
            .select(tokenFields)
            .from(tokens)
            .where(
              and(
                eq(tokens.workspaceId, input.workspaceId),
                eq(tokens.connectionId, input.connectionId),
              ),
            )
            .catch(rethrowQueryFailure),
        input.signal === undefined ? {} : { signal: input.signal },
      );
      return row === undefined ? null : tokenRecord(row);
    },
    claimOAuth2Refresh: async (input) => {
      const claimed = await withTenantScopedClient(
        pool,
        { workspaceId: input.workspaceId },
        (client) =>
          drizzle(client)
            .update(tokens)
            .set({ refreshBlockedUntil: blockedFor(input.blockSeconds) })
            .where(
              and(
                versionIs(input),
                or(
                  isNull(tokens.refreshBlockedUntil),
                  lte(tokens.refreshBlockedUntil, sql`clock_timestamp()`),
                ),
              ),
            )
            .returning({ id: tokens.id })
            .catch(rethrowQueryFailure),
        input.signal === undefined ? {} : { signal: input.signal },
      );
      return claimed.length === 1;
    },
    blockOAuth2Refresh: async (input) => {
      await withTenantScopedClient(
        pool,
        { workspaceId: input.workspaceId },
        (client) =>
          drizzle(client)
            .update(tokens)
            .set({ refreshBlockedUntil: blockedFor(input.blockSeconds) })
            .where(versionIs(input))
            .catch(rethrowQueryFailure),
      );
    },
    commitOAuth2Refresh: (input) => commitRefresh(pool, input),
    loseOAuth2Grant: (input) => loseGrant(pool, input),
    rejectOAuth2Token: async (input) => {
      const rejected = await withTenantScopedClient(
        pool,
        { workspaceId: input.workspaceId },
        (client) =>
          drizzle(client)
            .update(tokens)
            .set({ accessTokenExpiresAt: sql`clock_timestamp()` })
            .where(
              and(
                versionIs(input),
                eq(tokens.renewable, true),
                lte(
                  tokens.issuedAt,
                  sql`clock_timestamp()-make_interval(secs=>${input.minimumAgeSeconds}::double precision)`,
                ),
              ),
            )
            .returning({ id: tokens.id })
            .catch(rethrowQueryFailure),
        input.signal === undefined ? {} : { signal: input.signal },
      );
      return rejected.length === 1;
    },
  });
}

const blockedFor = (seconds: number) =>
  sql`clock_timestamp()+make_interval(secs=>${seconds}::double precision)`;

const versionIs = (
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    tokenId: string;
  }>,
) =>
  and(
    eq(tokens.workspaceId, input.workspaceId),
    eq(tokens.connectionId, input.connectionId),
    eq(tokens.id, input.tokenId),
  );

/** The sealed tokens a reconnect would replace, if they share its settings. */
export async function readEarlierTokens(
  pool: Pool,
  input: Parameters<OAuth2ConsentDatabase['readOAuth2EarlierTokens']>[0],
): ReturnType<OAuth2ConsentDatabase['readOAuth2EarlierTokens']> {
  const [row] = await withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    (client) =>
      drizzle(client)
        .select({
          id: tokens.id,
          sealed: {
            kmsKeyReference: tokens.kmsKeyReference,
            encryptedDataKey: tokens.encryptedDataKey,
            ciphertext: tokens.ciphertext,
            nonce: tokens.nonce,
            tag: tokens.authTag,
          },
        })
        .from(tokens)
        .where(
          and(
            eq(tokens.workspaceId, input.workspaceId),
            eq(tokens.connectionId, input.connectionId),
            eq(tokens.secretVersionId, input.secretVersionId),
          ),
        )
        .catch(rethrowQueryFailure),
  );
  return row === undefined ? null : Object.freeze(row);
}

/** One statement, so a client and its token can't come from two moments; it holds no lock. */
async function openGrant(
  pool: Pool,
  input: Parameters<OAuth2TokenStoreDatabase['openOAuth2Grant']>[0],
): ReturnType<OAuth2TokenStoreDatabase['openOAuth2Grant']> {
  const { workspaceId } = input;
  const [row] = await withTenantScopedClient(
    pool,
    { workspaceId },
    (client) =>
      drizzle(client)
        .select({
          secretVersionId: connections.currentSecretVersionId,
          settings: clients.settings,
          clientSecret: sealedFields,
          token: tokenFields,
        })
        .from(connections)
        .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
        .innerJoin(
          connectionSecretVersions,
          and(
            eq(connectionSecretVersions.workspaceId, connections.workspaceId),
            eq(connectionSecretVersions.connectionId, connections.id),
            eq(connectionSecretVersions.id, connections.currentSecretVersionId),
          ),
        )
        .innerJoin(
          clients,
          and(
            eq(clients.workspaceId, connections.workspaceId),
            eq(clients.connectionId, connections.id),
            eq(clients.secretVersionId, connections.currentSecretVersionId),
          ),
        )
        .innerJoin(
          tokens,
          and(
            eq(tokens.workspaceId, connections.workspaceId),
            eq(tokens.connectionId, connections.id),
            eq(tokens.secretVersionId, connections.currentSecretVersionId),
          ),
        )
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, input.connectionId),
            eq(connections.authType, CONNECTION_AUTH_TYPE.oauth2),
            eq(connections.status, CONNECTION_STATUS.active),
            eq(workspaces.status, 'active'),
          ),
        )
        .catch(rethrowQueryFailure),
    input.signal === undefined ? {} : { signal: input.signal },
  );
  if (row === undefined) return null;
  return Object.freeze({
    secretVersionId: row.secretVersionId,
    settings: row.settings,
    clientSecret: row.clientSecret,
    token: tokenRecord(row.token),
  });
}

/** A refresh changes the token row and lastHealthyAt: never an event or a revision. */
async function commitRefresh(
  pool: Pool,
  input: Parameters<OAuth2TokenStoreDatabase['commitOAuth2Refresh']>[0],
): Promise<boolean> {
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId: undefined,
    operation: async (client, workspaceId) => {
      await selectConnection(client, workspaceId, input.connectionId, {
        lock: true,
      });
      const { issued } = input;
      const updated = await drizzle(client)
        .update(tokens)
        .set({
          id: issued.id,
          ...sealedColumns(issued),
          issuedAt: sql`clock_timestamp()`,
          accessTokenExpiresAt: expiryOf(issued),
          renewable: issued.renewable,
          refreshBlockedUntil: null,
        })
        .where(versionIs(input))
        .returning({ id: tokens.id })
        .catch(rethrowQueryFailure);
      if (updated.length !== 1) return false;
      await drizzle(client)
        .update(connections)
        .set({ lastHealthyAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, input.connectionId),
          ),
        )
        .catch(rethrowQueryFailure);
      return true;
    },
  });
}

function lossActor(actor: OAuth2GrantLossActor) {
  return actor.source === 'run'
    ? ({
        actorKind: 'worker',
        actorId: actor.workerId,
        requestId: null,
        traceId: null,
      } as const)
    : ({
        actorKind: 'user',
        actorId: actor.actorId,
        requestId: actor.requestId ?? null,
        traceId: actor.traceId ?? null,
      } as const);
}

async function loseGrant(
  pool: Pool,
  input: Parameters<OAuth2TokenStoreDatabase['loseOAuth2Grant']>[0],
): Promise<boolean> {
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId: undefined,
    operation: async (client, workspaceId) => {
      await selectConnection(client, workspaceId, input.connectionId, {
        lock: true,
      });
      const db = drizzle(client);
      const deleted = await db
        .delete(tokens)
        .where(versionIs(input))
        .returning({ id: tokens.id })
        .catch(rethrowQueryFailure);
      if (deleted.length !== 1) return false;
      await db
        .update(connections)
        .set({
          status: CONNECTION_STATUS.reauthorizationRequired,
          lastErrorCode: input.errorCode,
          healthRevision: sql`${connections.healthRevision}+1`,
          lastHealthTransitionAt: sql`clock_timestamp()`,
          lastHealthTransitionSource: input.actor.source,
          ...(input.actor.source === 'run'
            ? { lastRunObservedAt: sql`clock_timestamp()` }
            : {}),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, input.connectionId),
          ),
        )
        .catch(rethrowQueryFailure);
      await db
        .insert(connectionEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          connectionId: input.connectionId,
          eventType: 'connection.reauthorization_required',
          ...lossActor(input.actor),
          metadata: {
            source: input.actor.source,
            status: CONNECTION_STATUS.reauthorizationRequired,
            reasonCode: input.errorCode,
          },
        })
        .catch(rethrowQueryFailure);
      return true;
    },
  });
}
