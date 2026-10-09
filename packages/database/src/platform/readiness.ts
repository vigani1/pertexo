import type { Pool } from 'pg';

export const EXPECTED_MIGRATION_HEAD = '0015_notifications_inbox.sql';
const MINIMUM_POSTGRES_MAJOR = 18;

export type DatabaseReadiness = Readonly<{
  migrationHead: string;
  postgresMajor: number;
  role: string;
}>;

/**
 * The database is reachable, new enough, and migrated to exactly the version
 * this build expects.
 */
export async function checkDatabaseReadiness(
  pool: Pick<Pool, 'query'>,
): Promise<DatabaseReadiness> {
  const result = await pool.query<{
    current_user: string;
    migration_head: string | null;
    postgres_major: number;
  }>(`
    select current_user,
      current_setting('server_version_num')::integer / 10000 as postgres_major,
      (select name from pertexo_internal.schema_migrations
        order by name desc limit 1) as migration_head
  `);
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
