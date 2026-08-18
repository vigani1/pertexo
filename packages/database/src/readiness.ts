import type { Pool } from 'pg';

export const EXPECTED_MIGRATION_HEAD = '0000_rls_probe.sql';
export const MINIMUM_POSTGRES_MAJOR = 18;

export type DatabaseReadiness = Readonly<{
  migrationHead: string;
  postgresMajor: number;
  role: string;
}>;

interface ReadinessRow {
  current_user: string;
  migration_head: string | null;
  owner: string;
  postgres_major: number;
  relforcerowsecurity: boolean;
  relrowsecurity: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
}

export async function checkDatabaseReadiness(
  pool: Pool,
): Promise<DatabaseReadiness> {
  const result = await pool.query<ReadinessRow>(`
    select
      current_user,
      current_setting('server_version_num')::integer / 10000 as postgres_major,
      role.rolsuper,
      role.rolbypassrls,
      pg_get_userbyid(table_class.relowner) as owner,
      table_class.relrowsecurity,
      table_class.relforcerowsecurity,
      (
        select name
        from pertexo_internal.schema_migrations
        order by name desc
        limit 1
      ) as migration_head
    from pg_roles role
    join pg_class table_class on table_class.oid = 'app.rls_probe_records'::regclass
    where role.rolname = current_user
  `);
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('Database readiness metadata is unavailable');
  }
  if (row.postgres_major < MINIMUM_POSTGRES_MAJOR) {
    throw new Error(
      `PostgreSQL ${String(MINIMUM_POSTGRES_MAJOR)}+ is required`,
    );
  }
  if (row.migration_head !== EXPECTED_MIGRATION_HEAD) {
    throw new Error('Database migration head is incompatible');
  }
  if (row.owner !== 'pertexo_owner') {
    throw new Error('Protected table has an unexpected owner');
  }
  if (!row.relrowsecurity || !row.relforcerowsecurity) {
    throw new Error('Protected table does not force row-level security');
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error('Runtime database role is privileged');
  }

  return Object.freeze({
    migrationHead: row.migration_head,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}
