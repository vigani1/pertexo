import { nodeRuns, workflows } from '@pertexo/database/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function clearCurrentAttempts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${nodeRuns}.ctid`.as('purge_ctid') })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.workspaceId, workspaceId),
          isNotNull(nodeRuns.currentAttemptId),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(nodeRuns)
      .set({ currentAttemptId: null, currentAttemptNumber: null })
      .from(page)
      .where(sql`${nodeRuns}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}

export async function clearPublishedVersions(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({ ctid: sql<string>`${workflows}.ctid`.as('purge_ctid') })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          isNotNull(workflows.publishedVersionId),
        ),
      )
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .update(workflows)
      .set({ publishedVersionId: null })
      .from(page)
      .where(sql`${workflows}.ctid=${page.ctid}`)
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
