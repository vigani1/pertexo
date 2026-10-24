import { eq, getTableName, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PurgeStep } from './contract.js';

type WorkspaceTable = PgTable & Readonly<{ workspaceId: AnyPgColumn }>;

/** Heap identity keeps a row changed during a lock wait out of the old page. */
export function deleteRows(table: WorkspaceTable): PurgeStep {
  return {
    name: getTableName(table),
    run: async (client, workspaceId, pageSize) => {
      const db = drizzle(client);
      const page = db.$with('page').as(
        db
          .select({ ctid: sql<string>`${table}.ctid`.as('purge_ctid') })
          .from(table)
          .where(eq(table.workspaceId, workspaceId))
          .limit(pageSize),
      );
      const removed = await db
        .with(page)
        .delete(table)
        .where(
          inArray(
            sql<string>`${table}.ctid`,
            db.select({ ctid: page.ctid }).from(page),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure);
      return removed.length;
    },
  };
}
