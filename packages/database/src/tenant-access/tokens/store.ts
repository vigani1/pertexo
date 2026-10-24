import { API_TOKEN_ACTIVE_LIMIT } from '@pertexo/workflow-model';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { ApiTokenCreateRequest } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import {claimCommand, completeCommand} from '../../platform/idempotency/repository.js';
import type { CommandIdentity } from '../../platform/idempotency/contract.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { withTenantScopedClient } from '../transactions.js';
import { hasCapability } from '@pertexo/workflow-model';
import { issueApiTokenCredential } from './credential.js';
import { apiTokenMetadata, type ApiTokenRow } from './metadata.js';
import { availableApiTokenScopes, tokenOwnerAuthority } from './authority.js';
import { authenticateApiToken } from './authenticate.js';
import {
  ApiTokenPolicyError,
  type ApiTokenCommand,
  type ApiTokenDatabase,
} from './types.js';

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
  const rows = await client.query<ApiTokenRow>(
    'select * from app.api_tokens where workspace_id=$1 and owner_user_id=$2 and id=$3',
    [input.workspaceId, input.ownerUserId, tokenId],
  );
  if (rows.rows[0] === undefined) throw new ApiTokenPolicyError('not_found');
  return rows.rows[0];
}
async function databaseNow(client: PoolClient): Promise<Date> {
  const rows = await client.query<{ now: Date }>(
    "select date_trunc('milliseconds',clock_timestamp()) now",
  );
  return singleRow(rows.rows).now;
}
async function recordTokenAudit(
  client: PoolClient,
  input: ApiTokenCommand,
  tokenId: string,
  action: string,
): Promise<void> {
  await client.query(
    `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
    values($1,$2,$3,$4,'api_token',$5,$6,$7,'{}'::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.ownerUserId,
      action,
      tokenId,
      input.requestId ?? null,
      input.traceId ?? null,
    ],
  );
}

export function createApiTokenDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ApiTokenDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const store: ApiTokenDatabase = {
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
  input: Parameters<ApiTokenDatabase['list']>[0],
): ReturnType<ApiTokenDatabase['list']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.ownerUserId },
    async (client) => {
      const authority = await tokenOwnerAuthority(client, input, 'read');
      const now = await databaseNow(client);
      const rows = await client.query<ApiTokenRow>(
        `select * from app.api_tokens where workspace_id=$1 and owner_user_id=$2 and ($3::uuid is null or id<$3) order by id desc limit $4`,
        [
          input.workspaceId,
          input.ownerUserId,
          input.after ?? null,
          input.limit + 1,
        ],
      );
      const items = rows.rows
        .slice(0, input.limit)
        .map((row) => apiTokenMetadata(row, authority.revision, now));
      return {
        items,
        nextCursor:
          rows.rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
        availableScopes: availableApiTokenScopes(authority.role),
      };
    },
    { ...(input.signal === undefined ? {} : { signal: input.signal }) },
  );
}

function createApiToken(
  pool: Pool,
  input: Parameters<ApiTokenDatabase['create']>[0],
): ReturnType<ApiTokenDatabase['create']> {
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
      const count = await client.query<{ count: number }>(
        'select count(*)::int count from app.api_tokens where workspace_id=$1 and owner_user_id=$2 and membership_revision=$3 and revoked_at is null and expires_at>$4',
        [input.workspaceId, input.ownerUserId, authority.revision, now],
      );
      if (singleRow(count.rows).count >= API_TOKEN_ACTIVE_LIMIT)
        throw new ApiTokenPolicyError('token_limit');
      const credential = issueApiTokenCredential(input.workspaceId, tokenId);
      const rows = await client.query<ApiTokenRow>(
        `insert into app.api_tokens(id,workspace_id,owner_user_id,name,secret_digest,scopes,membership_revision,created_at,expires_at)
        values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) returning *`,
        [
          tokenId,
          input.workspaceId,
          input.ownerUserId,
          input.name,
          credential.digest,
          serializeStoredExecutionJsonValue(input.scopes),
          authority.revision,
          now,
          new Date(now.getTime() + input.expiresInDays * 86_400_000),
        ],
      );
      await completeCommand(client, identity, { tokenId });
      await recordTokenAudit(client, input, tokenId, 'api.token.created');
      return {
        token: apiTokenMetadata(singleRow(rows.rows), authority.revision, now),
        secret: credential.secret,
        replayed: false as const,
      };
    },
    { ...(input.signal === undefined ? {} : { signal: input.signal }) },
  );
}

function revokeApiToken(
  pool: Pool,
  input: Parameters<ApiTokenDatabase['revoke']>[0],
): ReturnType<ApiTokenDatabase['revoke']> {
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
        if (row.revoked_at === null) {
          const rows = await client.query<ApiTokenRow>(
            'update app.api_tokens set revoked_at=$4 where workspace_id=$1 and owner_user_id=$2 and id=$3 and revoked_at is null returning *',
            [input.workspaceId, input.ownerUserId, input.tokenId, now],
          );
          row = singleRow(rows.rows);
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
