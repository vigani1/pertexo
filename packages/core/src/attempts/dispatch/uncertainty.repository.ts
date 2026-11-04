import { and, eq, exists, lt, sql, type SQL } from 'drizzle-orm';
import { alias, QueryBuilder, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { nodeAttempts } from '@pertexo/database/schema';

/** A retry does not resolve the earlier send until it confirms success. */
export function priorProviderDispatchUnresolved(
  current: Readonly<{
    workspaceId: AnyPgColumn;
    nodeRunId: AnyPgColumn;
    attemptNumber: AnyPgColumn;
  }>,
): SQL<boolean> {
  const prior = alias(nodeAttempts, 'prior_provider_dispatch');
  return exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(prior)
      .where(
        and(
          eq(prior.workspaceId, current.workspaceId),
          eq(prior.nodeRunId, current.nodeRunId),
          lt(prior.attemptNumber, current.attemptNumber),
          eq(prior.executorPossiblyDispatched, true),
          eq(prior.retryDecision, 'retry'),
        ),
      ),
  ).mapWith(Boolean);
}
