import { apiTokens, workspaceMemberships } from '@pertexo/database/schema';
import { and, asc, eq, exists, lte, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

/** Membership revisions never return to an older grant, so its metadata can expire. */
export const API_TOKEN_RETENTION_RULE = {
  name: 'api_tokens',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      cutoff = sql`clock_timestamp()-interval '30 days'`;
    const page = db.$with('page').as(
      db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .innerJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.workspaceId, apiTokens.workspaceId),
            eq(workspaceMemberships.userId, apiTokens.ownerUserId),
          ),
        )
        .where(
          or(
            lte(apiTokens.expiresAt, cutoff),
            lte(apiTokens.revokedAt, cutoff),
            and(
              ne(
                apiTokens.membershipRevision,
                workspaceMemberships.roleRevision,
              ),
              lte(workspaceMemberships.updatedAt, cutoff),
            ),
          ),
        )
        .orderBy(asc(apiTokens.id))
        .limit(pageSize),
    );
    return (
      await db
        .with(page)
        .delete(apiTokens)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(eq(page.id, apiTokens.id)),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
