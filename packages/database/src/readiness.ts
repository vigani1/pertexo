import type { Pool } from 'pg';

export const EXPECTED_MIGRATION_HEAD = '0009_oidc_login_transactions.sql';
export const MINIMUM_POSTGRES_MAJOR = 18;

export type DatabaseReadiness = Readonly<{
  migrationHead: string;
  postgresMajor: number;
  role: string;
}>;

interface ReadinessRow {
  can_delete: boolean;
  can_insert: boolean;
  can_references: boolean;
  can_select: boolean;
  can_trigger: boolean;
  can_truncate: boolean;
  can_update: boolean;
  current_user: string;
  migration_head: string | null;
  owner_member: boolean;
  owner: string;
  policy_compatible: boolean;
  phase1_grants_compatible: boolean;
  phase1_policy_compatible: boolean;
  phase1_schema_compatible: boolean;
  oidc_grants_compatible: boolean;
  oidc_schema_compatible: boolean;
  postgres_major: number;
  relforcerowsecurity: boolean;
  relrowsecurity: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  schema_compatible: boolean;
}

type ReadinessOptions = Readonly<{
  ownerRole: string;
}>;

export async function checkDatabaseReadiness(
  pool: Pool,
  options: ReadinessOptions = { ownerRole: 'pertexo_owner' },
): Promise<DatabaseReadiness> {
  const result = await pool.query<ReadinessRow>(
    `
    select
      current_user,
      current_setting('server_version_num')::integer / 10000 as postgres_major,
      role.rolsuper,
      role.rolbypassrls,
      pg_has_role(current_user, $1::name, 'MEMBER') as owner_member,
      pg_get_userbyid(table_class.relowner) as owner,
      table_class.relrowsecurity,
      table_class.relforcerowsecurity,
      has_table_privilege(current_user, table_class.oid, 'SELECT') as can_select,
      has_table_privilege(current_user, table_class.oid, 'INSERT') as can_insert,
      has_table_privilege(current_user, table_class.oid, 'UPDATE') as can_update,
      has_table_privilege(current_user, table_class.oid, 'DELETE') as can_delete,
      has_table_privilege(current_user, table_class.oid, 'TRUNCATE') as can_truncate,
      has_table_privilege(current_user, table_class.oid, 'REFERENCES') as can_references,
      has_table_privilege(current_user, table_class.oid, 'TRIGGER') as can_trigger,
      exists (
        select 1
        from pg_policy policy
        where policy.polrelid = table_class.oid
          and policy.polname = 'rls_probe_records_workspace_scope'
          and policy.polcmd = '*'
          and role.oid = any(policy.polroles)
          and policy.polqual is not null
          and policy.polwithcheck is not null
          and pg_get_expr(policy.polqual, policy.polrelid) like '%workspace_id%'
          and pg_get_expr(policy.polqual, policy.polrelid) like '%current_setting%'
          and pg_get_expr(policy.polwithcheck, policy.polrelid) like '%workspace_id%'
          and pg_get_expr(policy.polwithcheck, policy.polrelid) like '%current_setting%'
      ) as policy_compatible,
      (
        select count(*) = 1
        from pg_attribute attribute
        where attribute.attrelid = table_class.oid
          and attribute.attname = 'workspace_id'
          and attribute.attnotnull
          and attribute.atttypid = 'uuid'::regtype
          and not attribute.attisdropped
      ) and exists (
        select 1
        from pg_index table_index
        join pg_attribute workspace_attribute
          on workspace_attribute.attrelid = table_index.indrelid
          and workspace_attribute.attname = 'workspace_id'
        where table_index.indrelid = table_class.oid
          and workspace_attribute.attnum = any(table_index.indkey)
      ) as schema_compatible,
      (
        to_regclass('app.users') is not null
        and to_regclass('app.auth_identities') is not null
        and to_regclass('app.sessions') is not null
        and to_regclass('app.workspaces') is not null
        and to_regclass('app.workspace_memberships') is not null
        and to_regclass('app.audit_events') is not null
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = to_regclass('app.workspace_memberships')
            and a.attname = 'workspace_id' and a.attnotnull
            and a.atttypid = 'uuid'::regtype and not a.attisdropped
        )
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = to_regclass('app.audit_events')
            and a.attname = 'workspace_id' and a.attnotnull
            and a.atttypid = 'uuid'::regtype and not a.attisdropped
        )
      ) as phase1_schema_compatible,
      (
        (select c.relrowsecurity and c.relforcerowsecurity
         from pg_class c where c.oid = to_regclass('app.workspace_memberships'))
        and
        (select c.relrowsecurity and c.relforcerowsecurity
         from pg_class c where c.oid = to_regclass('app.audit_events'))
        and exists (
          select 1 from pg_policy p
          where p.polrelid = to_regclass('app.workspace_memberships')
            and p.polname = 'workspace_memberships_workspace_scope'
            and p.polqual is not null and p.polwithcheck is not null
        )
        and exists (
          select 1 from pg_policy p
          where p.polrelid = to_regclass('app.audit_events')
            and p.polname = 'audit_events_workspace_select'
            and p.polqual is not null
        )
        and exists (
          select 1 from pg_policy p
          where p.polrelid = to_regclass('app.audit_events')
            and p.polname = 'audit_events_workspace_insert'
            and p.polwithcheck is not null
        )
      ) as phase1_policy_compatible,
      (
        has_table_privilege(current_user, 'app.users', 'SELECT')
        and has_table_privilege(current_user, 'app.sessions', 'SELECT')
        and has_table_privilege(current_user, 'app.workspaces', 'SELECT')
        and has_table_privilege(current_user, 'app.workspace_memberships', 'SELECT')
        and has_table_privilege(current_user, 'app.audit_events', 'SELECT')
        and not has_table_privilege(current_user, 'app.audit_events', 'UPDATE')
        and not has_table_privilege(current_user, 'app.audit_events', 'DELETE')
      ) as phase1_grants_compatible,
      (
        to_regclass('app.oidc_login_transactions') is not null
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = to_regclass('app.oidc_login_transactions')
            and a.attname = 'state_digest' and a.attnotnull
            and a.atttypid = 'bpchar'::regtype and not a.attisdropped
        )
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = to_regclass('app.oidc_login_transactions')
            and a.attname = 'code_verifier_ciphertext' and a.attnotnull
            and not a.attisdropped
        )
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = to_regclass('app.oidc_login_transactions')
            and a.attname = 'nonce_ciphertext' and a.attnotnull
            and not a.attisdropped
        )
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = to_regclass('app.oidc_login_transactions')
            and a.attname = 'expires_at' and a.attnotnull
            and not a.attisdropped
        )
      ) as oidc_schema_compatible,
      (
        has_table_privilege(current_user, 'app.oidc_login_transactions', 'SELECT')
        and has_table_privilege(current_user, 'app.oidc_login_transactions', 'INSERT')
        and has_column_privilege(current_user, 'app.oidc_login_transactions', 'consumed_at', 'UPDATE')
        and not has_table_privilege(current_user, 'app.oidc_login_transactions', 'DELETE')
      ) as oidc_grants_compatible,
      (
        select name
        from pertexo_internal.schema_migrations
        order by name desc
        limit 1
      ) as migration_head
    from pg_roles role
    join pg_class table_class on table_class.oid = 'app.rls_probe_records'::regclass
    where role.rolname = current_user
  `,
    [options.ownerRole],
  );
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
  if (row.owner !== options.ownerRole) {
    throw new Error('Protected table has an unexpected owner');
  }
  if (!row.schema_compatible) {
    throw new Error('Protected table schema is incompatible');
  }
  if (!row.relrowsecurity || !row.relforcerowsecurity) {
    throw new Error('Protected table does not force row-level security');
  }
  if (!row.policy_compatible) {
    throw new Error('Workspace row-level security policy is incompatible');
  }
  if (!row.phase1_schema_compatible) {
    throw new Error('Identity/workspace schema is incompatible');
  }
  if (!row.phase1_policy_compatible) {
    throw new Error(
      'Identity/workspace row-level security policy is incompatible',
    );
  }
  if (!row.phase1_grants_compatible) {
    throw new Error('Identity/workspace runtime grants are incompatible');
  }
  if (!row.oidc_schema_compatible) {
    throw new Error('OIDC login transaction schema is incompatible');
  }
  if (!row.oidc_grants_compatible) {
    throw new Error('OIDC login transaction grants are incompatible');
  }
  if (
    !row.can_select ||
    !row.can_insert ||
    !row.can_update ||
    !row.can_delete ||
    row.can_truncate ||
    row.can_references ||
    row.can_trigger
  ) {
    throw new Error('Runtime database grants are incompatible');
  }
  if (row.rolsuper || row.rolbypassrls || row.owner_member) {
    throw new Error('Runtime database role is privileged');
  }

  return Object.freeze({
    migrationHead: row.migration_head,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}
