import { and, exists, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

type DeletionPage = Readonly<{
  table: PgTable;
  keys: readonly [AnyPgColumn, ...AnyPgColumn[]];
  condition: SQL | undefined;
  orderBy: readonly (AnyPgColumn | SQL)[];
  recheck?: SQL | undefined;
}>;

/** The explicit recheck preserves rules that must survive concurrent reactivation. */
export function deletionRule<const Name extends string>(
  name: Name,
  options: DeletionPage,
) {
  return {
    name,
    async run(client: PoolClient, pageSize: number): Promise<number> {
      const db = drizzle(client);
      const columns: Record<string, AnyPgColumn> = {};
      for (const column of options.keys) columns[column.name] = column;
      const page = db.$with('page').as(
        db
          .select(columns)
          .from(options.table)
          .where(options.condition)
          .orderBy(...options.orderBy)
          .limit(pageSize),
      );
      const matches = and(
        ...options.keys.map(
          (column) =>
            sql`${column}=${sql.identifier('page')}.${sql.identifier(column.name)}`,
        ),
      );
      const removed = await db
        .with(page)
        .delete(options.table)
        .where(
          and(
            exists(
              db
                .select({ one: sql`1` })
                .from(page)
                .where(matches),
            ),
            options.recheck,
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure);
      return removed.length;
    },
  };
}
