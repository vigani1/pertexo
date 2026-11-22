import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { apiTokens } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import {
  matchesApiTokenDigest,
  type ParsedApiTokenCredential,
} from './credential.js';
import { isActiveApiToken } from '../../shared/access/api-token-authority.js';
import { readApiTokenAuthority } from '../../shared/access/api-token-authority.repository.js';
import type { VerifiedApiToken } from './api-token.types.js';
import { MINUTE_INTERVAL } from '../../shared/sql-intervals.repository.js';

// A token's last use is written at most this often.
const LAST_USED_WRITE_MINUTES = 1;
const LAST_USED_WRITE_INTERVAL = sql`${LAST_USED_WRITE_MINUTES}*${MINUTE_INTERVAL}`;

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
      const row = await readApiTokenAuthority(db, input);
      if (
        row === undefined ||
        !matchesApiTokenDigest(input.digest, row.secretDigest) ||
        !isActiveApiToken(row)
      )
        return undefined;
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
              sql`${apiTokens.lastUsedAt}<=${row.observedAt}::timestamptz-${LAST_USED_WRITE_INTERVAL}`,
            ),
          ),
        )
        .catch(rethrowQueryFailure);
      return Object.freeze({
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        tokenId: row.id,
        name: row.name,
        scopes: Object.freeze([...row.scopes]),
        expiresAt: row.expiresAt,
      });
    },
    { ...(signal === undefined ? {} : { signal }) },
  );
}
