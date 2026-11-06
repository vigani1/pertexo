import { workspaceCreationIdempotencyRecords } from '@pertexo/database/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function purgeCreationReceipts(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        ctid: sql<string>`${workspaceCreationIdempotencyRecords}.ctid`.as(
          'ctid',
        ),
      })
      .from(workspaceCreationIdempotencyRecords)
      .where(eq(workspaceCreationIdempotencyRecords.resourceId, workspaceId))
      .limit(pageSize),
  );
  return (
    await db
      .with(page)
      .delete(workspaceCreationIdempotencyRecords)
      .where(
        inArray(
          sql<string>`${workspaceCreationIdempotencyRecords}.ctid`,
          db.select({ ctid: page.ctid }).from(page),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
