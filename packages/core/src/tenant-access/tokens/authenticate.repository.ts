import { and, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  apiTokens,
  users,
  workspaces,
  workspaceMemberships,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import {
  matchesApiTokenDigest,
  type ParsedApiTokenCredential,
} from './credential.js';
import { apiTokenStatus } from './metadata.js';
import type { VerifiedApiToken } from './contract.js';

/** Off the helper: no member is behind this yet. The token is what names one. */
export function authenticateApiToken(
  pool: Pool,
  input: ParsedApiTokenCredential,
  signal?: AbortSignal,
): Promise<VerifiedApiToken | undefined> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      const db = drizzle(client);
      const rows = await db
        .select({
          ...getTableColumns(apiTokens),
          ownerStatus: users.status,
          memberStatus: workspaceMemberships.status,
          workspaceStatus: workspaces.status,
          currentRevision: workspaceMemberships.roleRevision,
          observedAt: sql<Date>`clock_timestamp()`.mapWith(apiTokens.createdAt),
        })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.ownerUserId))
        .innerJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.workspaceId, apiTokens.workspaceId),
            eq(workspaceMemberships.userId, apiTokens.ownerUserId),
          ),
        )
        .innerJoin(workspaces, eq(workspaces.id, apiTokens.workspaceId))
        .where(
          and(
            eq(apiTokens.workspaceId, input.workspaceId),
            eq(apiTokens.id, input.tokenId),
          ),
        )
        .catch(rethrowQueryFailure);
      const row = rows[0];
      const tokenUnavailable =
        row === undefined ||
        !matchesApiTokenDigest(input.digest, row.secretDigest) ||
        apiTokenStatus(row, row.currentRevision, row.observedAt) !== 'active' ||
        row.ownerStatus !== 'active' ||
        row.memberStatus !== 'active' ||
        row.workspaceStatus !== 'active';
      if (tokenUnavailable) return undefined;
      // Verification is already complete; revocation doesn't cancel admitted work.
      await db
        .update(apiTokens)
        .set({ lastUsedAt: row.observedAt })
        .where(
          and(
            eq(apiTokens.workspaceId, input.workspaceId),
            eq(apiTokens.id, input.tokenId),
            isNull(apiTokens.revokedAt),
            or(
              isNull(apiTokens.lastUsedAt),
              sql`${apiTokens.lastUsedAt}<=${row.observedAt}::timestamptz-interval '1 minute'`,
            ),
          ),
        )
        .catch(rethrowQueryFailure);
      return Object.freeze({
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        tokenId: row.id,
        scopes: Object.freeze([...row.scopes]),
      });
    },
    { ...(signal === undefined ? {} : { signal }) },
  );
}
