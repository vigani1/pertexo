import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { serializeStoredExecutionJsonValue } from '../../runs/values/stored-execution.js';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { apiTokens } from '@pertexo/database/schema';
import { API_TOKEN_ACTIVE_LIMIT } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { ApiTokenCreateRequest } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
  generatePersistedId,
} from '@pertexo/database/platform';
import type { CommandIdentity } from '@pertexo/database/primitives';
import { hasCapability } from '@pertexo/workflow-model';
import { issueApiTokenCredential } from './credential.js';
import { apiTokenMetadata, type ApiTokenRow } from './metadata.js';
import {
  availableApiTokenScopes,
  tokenOwnerAuthority,
} from './authority.queries.js';
import { authenticateApiToken } from './authenticate.repository.js';
import { ApiTokenPolicyError } from './errors.js';
import type { ApiTokenCommand, ApiTokenStore } from './contract.js';

const receipt = z.object({ tokenId: z.uuid() }).strict();
const commandIdentity = (
  input: ApiTokenCommand,
): Omit<CommandIdentity, 'operation'> => ({
  workspaceId: input.workspaceId,
  scope: input.ownerUserId,
  idempotencyKey: input.idempotencyKey,
});
const sha256 = (input: unknown): string =>
  createHash('sha256').update(canonicalJson(input)).digest('hex');

function singleRow<Row>(rows: readonly Row[]): Row {
  const [row] = rows;
  if (row === undefined || rows.length !== 1)
    throw new Error('API token storage did not acknowledge exactly one row');
  return row;
}

async function tokenRow(
  client: PoolClient,
  input: ApiTokenCommand,
  tokenId: string,
): Promise<ApiTokenRow> {
  const rows = await drizzle(client)
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.workspaceId, input.workspaceId),
        eq(apiTokens.ownerUserId, input.ownerUserId),
        eq(apiTokens.id, tokenId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (rows[0] === undefined) throw new ApiTokenPolicyError('not_found');
  return rows[0];
}
async function databaseNow(client: PoolClient): Promise<Date> {
  const rows = await drizzle(client)
    .execute<{ now: string }>(
      sql`select date_trunc('milliseconds',clock_timestamp()) now`,
    )
    .catch(rethrowQueryFailure);
  return new Date(singleRow(rows.rows).now);
}
async function recordTokenAudit(
  client: PoolClient,
  input: ApiTokenCommand,
  tokenId: string,
  action: string,
): Promise<void> {
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.ownerUserId,
    action,
    targetType: 'api_token',
    targetId: tokenId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
  });
}

export function createApiTokenStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ApiTokenStore {
  const lease = acquireDatabasePool(config, runtime);
  const store: ApiTokenStore = {
    close: () => lease.close(),
    authenticate: (input, signal) =>
      authenticateApiToken(lease.pool, input, signal),
    list: (input) => listApiTokens(lease.pool, input),
    create: (input: ApiTokenCommand & ApiTokenCreateRequest) =>
      createApiToken(lease.pool, input),
    revoke: (input) => revokeApiToken(lease.pool, input),
  };
  return Object.freeze(store);
}

function listApiTokens(
  pool: Pool,
  input: Parameters<ApiTokenStore['list']>[0],
): ReturnType<ApiTokenStore['list']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.ownerUserId },
    async (client) => {
      const authority = await tokenOwnerAuthority(client, input, 'read');
      const now = await databaseNow(client);
      const after = input.after ?? null;
      const rows = await drizzle(client)
        .select()
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.workspaceId, input.workspaceId),
            eq(apiTokens.ownerUserId, input.ownerUserId),
            after === null ? undefined : lt(apiTokens.id, after),
          ),
        )
        .orderBy(desc(apiTokens.id))
        .limit(input.limit + 1)
        .catch(rethrowQueryFailure);
      const items = rows
        .slice(0, input.limit)
        .map((row) => apiTokenMetadata(row, authority.revision, now));
      return {
        items,
        nextCursor:
          rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
        availableScopes: availableApiTokenScopes(authority.role),
      };
    },
    { ...(input.signal === undefined ? {} : { signal: input.signal }) },
  );
}

function createApiToken(
  pool: Pool,
  input: Parameters<ApiTokenStore['create']>[0],
): ReturnType<ApiTokenStore['create']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.ownerUserId },
    async (client) => {
      const authority = await tokenOwnerAuthority(client, input, 'create');
      if (input.scopes.some((scope) => !hasCapability(authority.role, scope)))
        throw new ApiTokenPolicyError('scope_forbidden');
      const tokenId = generatePersistedId();
      const identity: CommandIdentity = {
        ...commandIdentity(input),
        operation: 'api.token.create',
      };
      const replay = await claimCommand(client, {
        ...identity,
        requestHash: sha256({
          name: input.name,
          scopes: input.scopes,
          expiresInDays: input.expiresInDays,
        }),
        resourceId: tokenId,
      });
      const now = await databaseNow(client);
      if (replay !== null)
        return {
          token: apiTokenMetadata(
            await tokenRow(client, input, receipt.parse(replay).tokenId),
            authority.revision,
            now,
          ),
          replayed: true as const,
        };
      const count = await drizzle(client)
        .select({ count: sql<number>`count(*)::int` })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.workspaceId, input.workspaceId),
            eq(apiTokens.ownerUserId, input.ownerUserId),
            eq(apiTokens.membershipRevision, authority.revision),
            isNull(apiTokens.revokedAt),
            gt(apiTokens.expiresAt, now),
          ),
        )
        .catch(rethrowQueryFailure);
      if (singleRow(count).count >= API_TOKEN_ACTIVE_LIMIT)
        throw new ApiTokenPolicyError('token_limit');
      const credential = issueApiTokenCredential(input.workspaceId, tokenId);
      const rows = await drizzle(client)
        .insert(apiTokens)
        .values({
          id: tokenId,
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          name: input.name,
          secretDigest: credential.digest,
          scopes: sql`${serializeStoredExecutionJsonValue(input.scopes)}::jsonb`,
          membershipRevision: authority.revision,
          createdAt: now,
          expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000),
        })
        .returning()
        .catch(rethrowQueryFailure);
      await completeCommand(client, identity, { tokenId });
      await recordTokenAudit(client, input, tokenId, 'api.token.created');
      return {
        token: apiTokenMetadata(singleRow(rows), authority.revision, now),
        secret: credential.secret,
        replayed: false as const,
      };
    },
    { ...(input.signal === undefined ? {} : { signal: input.signal }) },
  );
}

function revokeApiToken(
  pool: Pool,
  input: Parameters<ApiTokenStore['revoke']>[0],
): ReturnType<ApiTokenStore['revoke']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.ownerUserId },
    async (client) => {
      const authority = await tokenOwnerAuthority(client, input, 'revoke');
      const identity: CommandIdentity = {
        ...commandIdentity(input),
        operation: 'api.token.revoke',
      };
      const replay = await claimCommand(client, {
        ...identity,
        request: { tokenId: input.tokenId },
        resourceId: input.tokenId,
      });
      let row = await tokenRow(client, input, input.tokenId);
      const now = await databaseNow(client);
      if (replay === null) {
        if (row.revokedAt === null) {
          const rows = await drizzle(client)
            .update(apiTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(apiTokens.workspaceId, input.workspaceId),
                eq(apiTokens.ownerUserId, input.ownerUserId),
                eq(apiTokens.id, input.tokenId),
                isNull(apiTokens.revokedAt),
              ),
            )
            .returning()
            .catch(rethrowQueryFailure);
          row = singleRow(rows);
          await recordTokenAudit(
            client,
            input,
            input.tokenId,
            'api.token.revoked',
          );
        }
        await completeCommand(client, identity, { tokenId: input.tokenId });
      }
      return {
        token: apiTokenMetadata(row, authority.revision, now),
        replayed: replay !== null,
      };
    },
    { ...(input.signal === undefined ? {} : { signal: input.signal }) },
  );
}
