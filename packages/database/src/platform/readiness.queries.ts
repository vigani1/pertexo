import type { DatabaseReadiness } from './contract.js';
import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

export const EXPECTED_MIGRATION_HEAD = '0054_form_uploads.sql';
const MINIMUM_POSTGRES_MAJOR = 18;

/**
 * The database is reachable, new enough, and migrated to exactly the version
 * this build expects.
 */
export async function checkDatabaseReadiness(
  pool: Pick<Pool, 'query'>,
): Promise<DatabaseReadiness> {
  const query = new QueryBuilder()
    .select({
      current_user: sql<string>`current_user`.as('current_user'),
      migration_head: sql<string | null>`max(name)`.as('migration_head'),
      postgres_major:
        sql<number>`current_setting('server_version_num')::integer / 10000`.as(
          'postgres_major',
        ),
    })
    .from(sql`pertexo_internal.schema_migrations`);
  const statement = query.toSQL();
  const result = await pool.query<(typeof query)['_']['result'][number]>(
    statement.sql,
    statement.params,
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('Database readiness metadata is unavailable');
  if (row.postgres_major < MINIMUM_POSTGRES_MAJOR)
    throw new Error('PostgreSQL major version is unsupported');
  if (row.migration_head !== EXPECTED_MIGRATION_HEAD)
    throw new Error('Database migration head is incompatible');
  return Object.freeze({
    migrationHead: row.migration_head,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}
