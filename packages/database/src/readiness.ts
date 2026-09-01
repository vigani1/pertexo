import type { Pool } from 'pg';

import {
  checkCompatibilityReleasePreactivationTarget,
  checkExpectedCompatibilityRelease,
  checkExpectedCompatibilityReleaseSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
import {
  assertDatabaseReadinessRow,
  assertReadinessSupport,
  DATABASE_READINESS_SQL,
  type ReadinessRow,
} from './readiness-probe.js';

// Exact function-body hashes below are startup compatibility controls. Keep
// their inventory and synchronized rollout/rollback procedure aligned with
// docs/operations/database-function-readiness.md.

export const EXPECTED_MIGRATION_HEAD = '0073_transient_data_retention.sql';
export const MINIMUM_POSTGRES_MAJOR = 18;

export type DatabaseReadiness = Readonly<{
  migrationHead: string;
  postgresMajor: number;
  role: string;
}>;

export type ReadinessOptions = Readonly<{
  apiRuntimeRole?: string;
  ownerRole: string;
  workerRuntimeRole?: string;
  expectedCompatibilityRelease?: CompatibilityReleaseExpectation;
  expectedCompatibilityReleases?: CompatibilityReleaseExpectationSet;
  supportedGraphSchemaVersions?: readonly number[];
  supportedChecksumAlgorithms?: readonly string[];
  supportedExecutableSchemaVersions?: readonly number[];
}>;

export async function checkDatabaseReadiness(
  pool: Pool,
  options: ReadinessOptions = { ownerRole: 'pertexo_owner' },
): Promise<DatabaseReadiness> {
  if (
    options.expectedCompatibilityRelease !== undefined &&
    options.expectedCompatibilityReleases !== undefined
  )
    throw new Error(
      'Compatibility release readiness configuration is ambiguous',
    );
  assertReadinessSupport(options);
  const result = await pool.query<ReadinessRow>(DATABASE_READINESS_SQL, [
    options.ownerRole,
    options.workerRuntimeRole ?? 'pertexo_worker',
    options.apiRuntimeRole ?? 'pertexo_api',
  ]);
  const row = result.rows[0];
  assertDatabaseReadinessRow(row, {
    migrationHead: EXPECTED_MIGRATION_HEAD,
    minimumPostgresMajor: MINIMUM_POSTGRES_MAJOR,
    ownerRole: options.ownerRole,
  });

  await checkCompatibilityReleaseSchema(
    pool,
    options.ownerRole,
    options.workerRuntimeRole ?? 'pertexo_worker',
    options.expectedCompatibilityRelease !== undefined ||
      options.expectedCompatibilityReleases !== undefined,
  );
  await checkCompatibilityPreactivationAuthoritySchema(
    pool,
    options.ownerRole,
    options.workerRuntimeRole ?? 'pertexo_worker',
    options.expectedCompatibilityRelease !== undefined ||
      options.expectedCompatibilityReleases !== undefined,
  );
  if (options.expectedCompatibilityRelease !== undefined) {
    await checkExpectedCompatibilityRelease(
      pool,
      options.expectedCompatibilityRelease,
    );
  }
  if (options.expectedCompatibilityReleases !== undefined) {
    await checkExpectedCompatibilityReleaseSet(
      pool,
      options.expectedCompatibilityReleases,
    );
  }

  return Object.freeze({
    migrationHead: row.migration_head,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}

export async function checkDatabaseServingReadiness(
  pool: Pool,
  options: ReadinessOptions = { ownerRole: 'pertexo_owner' },
): Promise<DatabaseReadiness> {
  if (
    options.expectedCompatibilityRelease !== undefined &&
    options.expectedCompatibilityReleases !== undefined
  )
    throw new Error(
      'Compatibility release readiness configuration is ambiguous',
    );

  const result = await pool.query<{
    current_user: string;
    migration_head: string;
    postgres_major: number;
  }>(`
    select current_user,
      current_setting('server_version_num')::integer / 10000 as postgres_major,
      (select name from pertexo_internal.schema_migrations
        order by name desc limit 1) as migration_head
  `);
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('Database serving readiness metadata is unavailable');
  if (row.postgres_major < MINIMUM_POSTGRES_MAJOR)
    throw new Error('PostgreSQL major version is unsupported');
  if (row.migration_head !== EXPECTED_MIGRATION_HEAD)
    throw new Error('Database migration head is incompatible');

  if (options.expectedCompatibilityRelease !== undefined)
    await checkExpectedCompatibilityRelease(
      pool,
      options.expectedCompatibilityRelease,
    );
  if (options.expectedCompatibilityReleases !== undefined)
    await checkExpectedCompatibilityReleaseSet(
      pool,
      options.expectedCompatibilityReleases,
    );

  return Object.freeze({
    migrationHead: row.migration_head,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}

export async function checkDatabasePreactivationReadiness(
  pool: Pool,
  options: ReadinessOptions &
    Readonly<{
      expectedCompatibilityReleases: CompatibilityReleaseExpectationSet;
      preactivationTarget: CompatibilityReleaseExpectation;
    }>,
): Promise<DatabaseReadiness> {
  const readiness = await checkDatabaseReadiness(pool, options);
  await checkCompatibilityReleasePreactivationTarget(
    pool,
    options.expectedCompatibilityReleases,
    options.preactivationTarget,
  );
  return readiness;
}

async function checkCompatibilityPreactivationAuthoritySchema(
  pool: Pool,
  ownerRole: string,
  workerRole: string,
  requireCurrentRoleRead: boolean,
): Promise<void> {
  const result = await pool.query<{ compatible: boolean }>(
    `select (
       to_regclass('app.node_compatibility_preactivation_checks') is not null
       and to_regclass('app.node_compatibility_activation_approvals') is not null
       and to_regclass('app.node_compatibility_activations') is not null
       and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.node_compatibility_preactivation_checks'))) = $1
       and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.node_compatibility_activation_approvals'))) = $1
       and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.node_compatibility_activations'))) = $1
       and (select count(*) = 8 from pg_attribute where attrelid = to_regclass('app.node_compatibility_preactivation_checks') and attnum > 0 and not attisdropped)
       and (select count(*) = 9 from pg_attribute where attrelid = to_regclass('app.node_compatibility_activation_approvals') and attnum > 0 and not attisdropped)
       and (select count(*) = 10 from pg_attribute where attrelid = to_regclass('app.node_compatibility_activations') and attnum > 0 and not attisdropped)
       and (select count(*) = 7 from pg_attribute where attrelid = to_regclass('app.node_compatibility_current') and attnum > 0 and not attisdropped)
       and not exists (
         select 1
           from (values
             ('node_compatibility_preactivation_checks', 'node_compatibility_preactivation_checks_immutable'),
             ('node_compatibility_activation_approvals', 'node_compatibility_activation_approvals_immutable'),
             ('node_compatibility_activations', 'node_compatibility_activations_immutable')
           ) as required(table_name, trigger_name)
          where not exists (
            select 1
              from pg_trigger trigger
             where trigger.tgrelid = ('app.' || required.table_name)::regclass
               and trigger.tgname = required.trigger_name
               and trigger.tgenabled = 'O'
               and not trigger.tgisinternal
               and trigger.tgfoid = 'app.reject_node_compatibility_release_change()'::regprocedure
          )
       )
       and not exists (
         select 1
           from (values
             ('prepare_node_compatibility_release(integer,character varying,jsonb,integer,character varying,character varying,character varying,character varying)', true, 'cdc8c35b360133824aa9f2722c240934'),
             ('lock_node_compatibility_current_supported(jsonb)', true, 'f76fa13098d07326e52621ae076882d6'),
             ('record_node_compatibility_preactivation(uuid,character varying,integer,character varying,character varying,character varying,jsonb)', true, '1cd8c85bfd2342dd954686fffc341238'),
             ('approve_node_compatibility_activation(uuid,character varying,integer,character varying,jsonb,jsonb,character varying,character varying)', true, '07e8e75948b469026b72060a33810e65'),
             ('activate_node_compatibility_release(uuid,integer,character varying,uuid,character varying,character varying,character varying)', true, 'bc6581fed30a75832fdf7133613f355e'),
             ('node_compatibility_artifact_set_valid(jsonb)', false, '1ee6b6a001eb02b6b5a95f671240ae69'),
             ('compatibility_preactivation_cohort_complete(character varying,integer,character varying,character varying,jsonb)', false, '4bd8e8a005eebc013d41ae6b6a55b976')
           ) as required(signature, security_definer, body_md5)
          where not exists (
            select 1
              from pg_proc function
             where function.oid = ('app.' || required.signature)::regprocedure
               and function.prosecdef = required.security_definer
               and pg_get_userbyid(function.proowner) = $1
               and function.proconfig = array['search_path=pg_catalog, app']::text[]
               and md5(function.prosrc) = required.body_md5
               and not exists (
                 select 1
                   from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                  where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
               )
          )
       )
       and exists (
         select 1 from pg_constraint
          where conrelid = 'app.node_compatibility_current'::regclass
            and conname = 'node_compatibility_current_activation_approval_fk'
            and contype = 'f'
            and convalidated
       )
       and (not $3 or has_function_privilege(current_user, 'app.lock_node_compatibility_current_supported(jsonb)', 'EXECUTE'))
       and has_function_privilege($2, 'app.lock_node_compatibility_current_supported(jsonb)', 'EXECUTE')
       and not exists (
         select 1
           from (values
             ('prepare_node_compatibility_release(integer,character varying,jsonb,integer,character varying,character varying,character varying,character varying)'),
             ('record_node_compatibility_preactivation(uuid,character varying,integer,character varying,character varying,character varying,jsonb)'),
             ('approve_node_compatibility_activation(uuid,character varying,integer,character varying,jsonb,jsonb,character varying,character varying)'),
             ('activate_node_compatibility_release(uuid,integer,character varying,uuid,character varying,character varying,character varying)'),
             ('node_compatibility_artifact_set_valid(jsonb)'),
             ('compatibility_preactivation_cohort_complete(character varying,integer,character varying,character varying,jsonb)')
           ) as forbidden(signature)
          where has_function_privilege(current_user, 'app.' || forbidden.signature, 'EXECUTE')
             or has_function_privilege($2, 'app.' || forbidden.signature, 'EXECUTE')
       )
       and not (
         has_table_privilege(current_user, 'app.node_compatibility_preactivation_checks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege(current_user, 'app.node_compatibility_activation_approvals', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege(current_user, 'app.node_compatibility_activations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege($2, 'app.node_compatibility_preactivation_checks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege($2, 'app.node_compatibility_activation_approvals', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege($2, 'app.node_compatibility_activations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       )
     ) as compatible`,
    [ownerRole, workerRole, requireCurrentRoleRead],
  );
  if (result.rows[0]?.compatible !== true)
    throw new Error(
      'Node compatibility preactivation authority is incompatible',
    );
}

async function checkCompatibilityReleaseSchema(
  pool: Pool,
  ownerRole: string,
  workerRole: string,
  requireCurrentRoleRead: boolean,
): Promise<void> {
  const result = await pool.query<{
    compatible: boolean;
    current_role_can_read: boolean;
    current_role_can_write: boolean;
    worker_can_read: boolean;
    worker_can_write: boolean;
  }>(
    `select
       (
         to_regclass('app.node_compatibility_releases') is not null
         and to_regclass('app.node_compatibility_current') is not null
         and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.node_compatibility_releases'))) = $1
         and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.node_compatibility_current'))) = $1
         and (select count(*) = 9 from pg_attribute where attrelid = to_regclass('app.node_compatibility_releases') and attnum > 0 and not attisdropped)
         and (select count(*) = 7 from pg_attribute where attrelid = to_regclass('app.node_compatibility_current') and attnum > 0 and not attisdropped)
         and exists (
           select 1 from pg_trigger
            where tgrelid = to_regclass('app.node_compatibility_releases')
              and tgname = 'node_compatibility_releases_immutable'
              and tgenabled = 'O' and not tgisinternal
         )
         and exists (
           select 1 from pg_trigger trigger
            where trigger.tgrelid = to_regclass('app.node_compatibility_releases')
              and trigger.tgname = 'node_compatibility_releases_phase3_core_non_removal'
              and trigger.tgenabled = 'O' and not trigger.tgisinternal
              and trigger.tgtype = 7
              and trigger.tgfoid = 'app.enforce_phase3_core_executor_non_removal()'::regprocedure
         )
         and exists (
           select 1
             from pg_proc function
             join pg_namespace namespace on namespace.oid = function.pronamespace
            where namespace.nspname = 'app'
              and function.proname = 'enforce_phase3_core_executor_non_removal'
              and not function.prosecdef
              and pg_get_userbyid(function.proowner) = $1
              and function.proconfig = array['search_path=pg_catalog, app']::text[]
              and md5(function.prosrc) = '338c35d21e71957aed153ac764b2e450'
              and not exists (
                select 1
                  from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                 where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
              )
         )
         and exists (
           select 1
             from pg_proc function
             join pg_namespace namespace on namespace.oid = function.pronamespace
            where namespace.nspname = 'app'
              and function.proname = 'lock_node_compatibility_current'
              and function.prosecdef
              and pg_get_userbyid(function.proowner) = $1
              and function.proconfig = array['search_path=pg_catalog, app']::text[]
         )
       ) as compatible,
       (
         has_table_privilege(current_user, 'app.node_compatibility_releases', 'SELECT')
         and has_table_privilege(current_user, 'app.node_compatibility_current', 'SELECT')
         and has_function_privilege(current_user, 'app.lock_node_compatibility_current(integer, character varying, jsonb)', 'EXECUTE')
       ) as current_role_can_read,
       (
         has_table_privilege(current_user, 'app.node_compatibility_releases', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege(current_user, 'app.node_compatibility_current', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       ) as current_role_can_write,
       (
         has_table_privilege($2, 'app.node_compatibility_releases', 'SELECT')
         and has_table_privilege($2, 'app.node_compatibility_current', 'SELECT')
         and has_function_privilege($2, 'app.lock_node_compatibility_current(integer, character varying, jsonb)', 'EXECUTE')
       ) as worker_can_read,
       (
         has_table_privilege($2, 'app.node_compatibility_releases', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege($2, 'app.node_compatibility_current', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       ) as worker_can_write`,
    [ownerRole, workerRole],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    !row.compatible ||
    row.worker_can_write ||
    !row.worker_can_read ||
    row.current_role_can_write ||
    (requireCurrentRoleRead && !row.current_role_can_read)
  ) {
    throw new Error('Node compatibility release authority is incompatible');
  }
}
