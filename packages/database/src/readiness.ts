import type { Pool } from 'pg';

import {
  checkCompatibilityReleasePreactivationTarget,
  checkExpectedCompatibilityRelease,
  checkExpectedCompatibilityReleaseSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';

export const EXPECTED_MIGRATION_HEAD = '0036_resend_api_key_connections.sql';
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
  oidc_capacity_compatible: boolean;
  oidc_schema_compatible: boolean;
  phase2_grants_compatible: boolean;
  phase2_policy_compatible: boolean;
  phase2_schema_compatible: boolean;
  phase3_grants_compatible: boolean;
  phase3_policy_compatible: boolean;
  phase3_schema_compatible: boolean;
  phase4_connections_compatible: boolean;
  phase4_integration_usage_compatible: boolean;
  phase4_preview_artifacts_compatible: boolean;
  phase4_preview_terminal_facts_compatible: boolean;
  execution_values_compatible: boolean;
  coordinator_run_store_compatible: boolean;
  durable_wait_compatible: boolean;
  failure_notification_compatible: boolean;
  due_node_wakeups_compatible: boolean;
  postgres_major: number;
  relforcerowsecurity: boolean;
  relrowsecurity: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  schema_compatible: boolean;
}

export type ReadinessOptions = Readonly<{
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
  const supportedGraphSchemaVersions = options.supportedGraphSchemaVersions ?? [
    1,
  ];
  if (
    supportedGraphSchemaVersions.length !== 1 ||
    supportedGraphSchemaVersions[0] !== 1
  ) {
    throw new Error('Workflow graph schema support is incompatible');
  }
  const supportedChecksumAlgorithms = options.supportedChecksumAlgorithms ?? [
    'wf:v1:sha256',
    'wf:v2:sha256',
  ];
  if (
    supportedChecksumAlgorithms.length !== 2 ||
    supportedChecksumAlgorithms[0] !== 'wf:v1:sha256' ||
    supportedChecksumAlgorithms[1] !== 'wf:v2:sha256'
  ) {
    throw new Error('Workflow checksum support is incompatible');
  }
  const supportedExecutableSchemaVersions =
    options.supportedExecutableSchemaVersions ?? [2];
  if (
    supportedExecutableSchemaVersions.length !== 1 ||
    supportedExecutableSchemaVersions[0] !== 2
  ) {
    throw new Error('Workflow executable schema support is incompatible');
  }
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
      (exists (
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
      ) or (
        not has_table_privilege(current_user, table_class.oid, 'SELECT')
        and not has_table_privilege(current_user, table_class.oid, 'INSERT')
        and not has_table_privilege(current_user, table_class.oid, 'UPDATE')
        and not has_table_privilege(current_user, table_class.oid, 'DELETE')
        and not (role.oid = any(coalesce((select polroles from pg_policy where polrelid = table_class.oid and polname = 'rls_probe_records_workspace_scope'), '{}'::oid[])))
      )) as policy_compatible,
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
        case when has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE') then
        has_table_privilege(current_user, 'app.users', 'SELECT')
        and has_table_privilege(current_user, 'app.sessions', 'SELECT')
        and has_table_privilege(current_user, 'app.workspaces', 'SELECT')
        and has_table_privilege(current_user, 'app.workspace_memberships', 'SELECT')
        and has_table_privilege(current_user, 'app.audit_events', 'SELECT')
        and not has_table_privilege(current_user, 'app.audit_events', 'UPDATE')
        and not has_table_privilege(current_user, 'app.audit_events', 'DELETE')
        else
          not has_table_privilege(current_user, 'app.users', 'SELECT')
          and not has_table_privilege(current_user, 'app.sessions', 'SELECT')
          and not has_table_privilege(current_user, 'app.auth_identities', 'SELECT')
        end
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
        case when has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE') then
        has_table_privilege(current_user, 'app.oidc_login_transactions', 'SELECT')
        and has_table_privilege(current_user, 'app.oidc_login_transactions', 'INSERT')
        and has_column_privilege(current_user, 'app.oidc_login_transactions', 'consumed_at', 'UPDATE')
        and not has_table_privilege(current_user, 'app.oidc_login_transactions', 'DELETE')
        else
          not has_table_privilege(current_user, 'app.oidc_login_transactions', 'SELECT')
          and not has_table_privilege(current_user, 'app.oidc_login_transactions', 'INSERT')
          and not has_table_privilege(current_user, 'app.oidc_login_transactions', 'UPDATE')
          and not has_table_privilege(current_user, 'app.oidc_login_transactions', 'DELETE')
        end
      ) as oidc_grants_compatible,
      (
        exists (
          select 1
          from pg_proc proc
          join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'app'
            and proc.proname = 'enforce_oidc_login_transaction_capacity'
            and proc.prosecdef
            and pg_get_userbyid(proc.proowner) = $1
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']
            and not has_function_privilege(current_user, proc.oid, 'EXECUTE')
        )
        and exists (
          select 1
          from pg_trigger trig
          join pg_proc proc on proc.oid = trig.tgfoid
          join pg_namespace namespace on namespace.oid = proc.pronamespace
          where trig.tgrelid = to_regclass('app.oidc_login_transactions')
            and trig.tgname = 'oidc_login_transactions_capacity'
            and not trig.tgisinternal
            and trig.tgenabled = 'O'
            and trig.tgtype = 7
            and namespace.nspname = 'app'
            and proc.proname = 'enforce_oidc_login_transaction_capacity'
        )
      ) as oidc_capacity_compatible,
      (
        to_regclass('app.workflows') is not null
        and to_regclass('app.workflow_drafts') is not null
        and to_regclass('app.workflow_versions') is not null
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_drafts')
            and conname = 'workflow_drafts_workflow_workspace_fk'
            and confdeltype = 'c'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflows')
            and conname = 'workflows_published_version_workspace_fk'
        )
        and exists (
          select 1 from pg_trigger trigger
          join pg_proc proc on proc.oid = trigger.tgfoid
          where trigger.tgrelid = to_regclass('app.workflow_versions')
            and trigger.tgname = 'workflow_versions_immutable'
            and not trigger.tgisinternal and trigger.tgenabled = 'O'
            and trigger.tgtype = 27
            and proc.oid = to_regprocedure('app.reject_workflow_version_mutation()')
            and not proc.prosecdef
            and pg_get_userbyid(proc.proowner) = $1
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']
        )
        and (select pg_get_userbyid(relowner) = $1 from pg_class where oid = to_regclass('app.workflows'))
        and (select pg_get_userbyid(relowner) = $1 from pg_class where oid = to_regclass('app.workflow_drafts'))
        and (select pg_get_userbyid(relowner) = $1 from pg_class where oid = to_regclass('app.workflow_versions'))
        and exists (select 1 from pg_constraint where conrelid = to_regclass('app.workflows') and conname = 'workflows_activation_status_valid' and pg_get_constraintdef(oid) like '%activation_status%inactive%')
        and exists (select 1 from pg_constraint where conrelid = to_regclass('app.workflows') and conname = 'workflows_created_at_millisecond_precision' and pg_get_constraintdef(oid) like '%date_trunc%milliseconds%created_at%')
        and exists (select 1 from pg_constraint where conrelid = to_regclass('app.workflow_drafts') and conname = 'workflow_drafts_revision_positive')
        and exists (select 1 from pg_constraint where conrelid = to_regclass('app.workflow_drafts') and conname = 'workflow_drafts_schema_version_supported' and pg_get_constraintdef(oid) like '%schema_version = 1%')
        and exists (select 1 from pg_constraint where conrelid = to_regclass('app.workflow_versions') and conname = 'workflow_versions_schema_version_supported' and pg_get_constraintdef(oid) like '%schema_version = 1%')
        and exists (select 1 from pg_constraint where conrelid = to_regclass('app.workflow_versions') and conname = 'workflow_versions_checksum_format')
        and exists (select 1 from pg_indexes where schemaname = 'app' and tablename = 'workflows' and indexname = 'workflows_workspace_created_idx' and indexdef like '%workspace_id, created_at, id%')
        and exists (select 1 from pg_indexes where schemaname = 'app' and tablename = 'workflows' and indexname = 'workflows_workspace_name_idx' and indexdef like '%workspace_id, name, id%')
        and exists (select 1 from pg_indexes where schemaname = 'app' and tablename = 'workflow_drafts' and indexname = 'workflow_drafts_workspace_idx' and indexdef like '%workspace_id, workflow_id%')
        and exists (select 1 from pg_indexes where schemaname = 'app' and tablename = 'workflow_versions' and indexname = 'workflow_versions_workspace_workflow_idx' and indexdef like '%workspace_id, workflow_id, version_number DESC%')
        and exists (select 1 from pg_indexes where schemaname = 'app' and tablename = 'workflow_versions' and indexname = 'workflow_versions_checksum_unique' and indexdef like '%workflow_id, checksum%')
        and exists (select 1 from pg_indexes where schemaname = 'app' and tablename = 'outbox_events' and indexname = 'outbox_events_dispatch_job_due_idx' and indexdef like '%job_name, available_at, id%' and indexdef like '%published_at IS NULL%' and indexdef like '%failed_at IS NULL%')
        and not exists (
          select 1 from (values
            ('workflows','id','uuid',true),
            ('workflows','workspace_id','uuid',true),
            ('workflows','name','character varying(128)',true),
            ('workflows','lifecycle_status','character varying(32)',true),
            ('workflows','activation_status','character varying(32)',true),
            ('workflows','published_version_id','uuid',false),
            ('workflows','created_by','uuid',true),
            ('workflows','created_at','timestamp with time zone',true),
            ('workflows','updated_at','timestamp with time zone',true),
            ('workflow_drafts','workflow_id','uuid',true),
            ('workflow_drafts','workspace_id','uuid',true),
            ('workflow_drafts','revision','integer',true),
            ('workflow_drafts','schema_version','integer',true),
            ('workflow_drafts','graph_json','jsonb',true),
            ('workflow_drafts','updated_by','uuid',true),
            ('workflow_drafts','updated_at','timestamp with time zone',true),
            ('workflow_versions','id','uuid',true),
            ('workflow_versions','workspace_id','uuid',true),
            ('workflow_versions','workflow_id','uuid',true),
            ('workflow_versions','version_number','integer',true),
            ('workflow_versions','schema_version','integer',true),
            ('workflow_versions','graph_json','jsonb',true),
            ('workflow_versions','checksum','character varying(77)',true),
            ('workflow_versions','executable_schema_version','integer',false),
            ('workflow_versions','executable_json','jsonb',false),
            ('workflow_versions','compatibility_release_epoch','integer',false),
            ('workflow_versions','published_by','uuid',true),
            ('workflow_versions','published_at','timestamp with time zone',true)
          ) expected(table_name,column_name,type_name,is_not_null)
          where not exists (
            select 1 from pg_attribute attribute
            where attribute.attrelid = to_regclass('app.' || expected.table_name)
              and attribute.attname = expected.column_name
              and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
              and attribute.attnotnull = expected.is_not_null
              and not attribute.attisdropped
          )
        )
        and exists (select 1 from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid=to_regclass('app.workflows') and a.attname='activation_status' and pg_get_expr(d.adbin,d.adrelid) like '%inactive%')
        and exists (select 1 from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid=to_regclass('app.workflow_drafts') and a.attname='revision' and pg_get_expr(d.adbin,d.adrelid) = '1')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflow_versions') and conname='workflow_versions_workspace_identity_unique' and contype='u')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflow_versions') and conname='workflow_versions_number_unique' and contype='u')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflow_versions') and conname='workflow_versions_checksum_unique' and contype='u')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflow_drafts') and conname='workflow_drafts_pkey' and contype='p')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflow_drafts') and conname='workflow_drafts_workflow_workspace_fk' and contype='f' and confrelid=to_regclass('app.workflows') and confdeltype='c')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflow_versions') and conname='workflow_versions_workflow_workspace_fk' and contype='f' and confrelid=to_regclass('app.workflows') and confdeltype='r')
        and exists (select 1 from pg_constraint where conrelid=to_regclass('app.workflows') and conname='workflows_published_version_workspace_fk' and contype='f' and confrelid=to_regclass('app.workflow_versions') and confdeltype='r')
        and (select count(*) = 9 from pg_attribute where attrelid = to_regclass('app.workflows') and attnum > 0 and not attisdropped)
        and (select count(*) = 7 from pg_attribute where attrelid = to_regclass('app.workflow_drafts') and attnum > 0 and not attisdropped)
        and (select count(*) = 12 from pg_attribute where attrelid = to_regclass('app.workflow_versions') and attnum > 0 and not attisdropped)
        and exists (select 1 from pg_attribute where attrelid = to_regclass('app.workflows') and attname = 'published_version_id' and atttypid = 'uuid'::regtype and not attnotnull)
        and exists (select 1 from pg_attribute where attrelid = to_regclass('app.workflow_drafts') and attname = 'graph_json' and atttypid = 'jsonb'::regtype and attnotnull)
        and exists (select 1 from pg_attribute where attrelid = to_regclass('app.workflow_versions') and attname = 'checksum' and atttypid = 'varchar'::regtype and atttypmod = 81 and attnotnull)
        and exists (
          select 1 from pg_proc proc join pg_namespace n on n.oid = proc.pronamespace
          where n.nspname = 'app' and proc.proname = 'create_workflow_with_draft'
            and proc.prosecdef and pg_get_userbyid(proc.proowner) = $1
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']
            and not exists (
              select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            )
        )
      ) as phase2_schema_compatible,
      (
        (select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('app.workflows'))
        and (select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('app.workflow_drafts'))
        and (select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('app.workflow_versions'))
        and (select count(*) from pg_policy where polrelid in (to_regclass('app.workflows'), to_regclass('app.workflow_drafts'), to_regclass('app.workflow_versions'))) = 4
        and exists (select 1 from pg_policy p where p.polrelid = to_regclass('app.workflows') and p.polname = 'workflows_workspace_scope' and p.polqual is not null and p.polwithcheck is not null and cardinality(p.polroles) = 2 and (select oid from pg_roles where rolname = $1) = any(p.polroles) and exists (select 1 from unnest(p.polroles) policy_role where policy_role <> (select oid from pg_roles where rolname = $1) and has_function_privilege(pg_get_userbyid(policy_role), 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')))
        and exists (select 1 from pg_policy p where p.polrelid = to_regclass('app.workflow_drafts') and p.polname = 'workflow_drafts_workspace_scope' and p.polqual is not null and p.polwithcheck is not null and cardinality(p.polroles) = 2 and (select oid from pg_roles where rolname = $1) = any(p.polroles) and exists (select 1 from unnest(p.polroles) policy_role where policy_role <> (select oid from pg_roles where rolname = $1) and has_function_privilege(pg_get_userbyid(policy_role), 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')))
        and exists (select 1 from pg_policy p where p.polrelid = to_regclass('app.workflow_versions') and p.polname = 'workflow_versions_workspace_scope' and p.polqual is not null and p.polwithcheck is not null and cardinality(p.polroles) = 2 and (select oid from pg_roles where rolname = $1) = any(p.polroles) and exists (select 1 from unnest(p.polroles) policy_role where policy_role <> (select oid from pg_roles where rolname = $1) and has_function_privilege(pg_get_userbyid(policy_role), 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')))
        and not exists (
          select 1 from (values
            ('workflows', 'workflows_workspace_scope'),
            ('workflow_drafts', 'workflow_drafts_workspace_scope'),
            ('workflow_versions', 'workflow_versions_workspace_scope')
          ) expected(table_name, policy_name)
          where not exists (
            select 1 from pg_policy policy
            where policy.polrelid = to_regclass('app.' || expected.table_name)
              and policy.polname = expected.policy_name
              and policy.polcmd = '*'
              and cardinality(policy.polroles) = 2
              and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
              and exists (
                select 1 from unnest(policy.polroles) policy_role
                where policy_role <> (select oid from pg_roles where rolname = $1)
                  and has_function_privilege(
                    pg_get_userbyid(policy_role),
                    'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)',
                    'EXECUTE'
                  )
              )
              and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
              and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
          )
        )
      ) as phase2_policy_compatible,
      (
        case when has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE') then
        has_table_privilege(current_user, 'app.workflows', 'SELECT')
        and not has_table_privilege(current_user, 'app.workflows', 'INSERT')
        and not has_table_privilege(current_user, 'app.workflows', 'DELETE')
        and has_column_privilege(current_user, 'app.workflows', 'name', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'lifecycle_status', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'activation_status', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'published_version_id', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'updated_at', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'id', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'workspace_id', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'created_by', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'created_at', 'UPDATE')
        and has_table_privilege(current_user, 'app.workflow_drafts', 'SELECT')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'revision', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'schema_version', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'graph_json', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'updated_by', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'updated_at', 'UPDATE')
        and not has_table_privilege(current_user, 'app.workflow_drafts', 'INSERT')
        and not has_table_privilege(current_user, 'app.workflow_drafts', 'DELETE')
        and not has_column_privilege(current_user, 'app.workflow_drafts', 'workflow_id', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflow_drafts', 'workspace_id', 'UPDATE')
        and has_table_privilege(current_user, 'app.workflow_versions', 'SELECT')
        and has_table_privilege(current_user, 'app.workflow_versions', 'INSERT')
        and not has_table_privilege(current_user, 'app.workflow_versions', 'UPDATE')
        and not has_table_privilege(current_user, 'app.workflow_versions', 'DELETE')
        and has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')
        else
          not has_table_privilege(current_user, 'app.workflows', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflows', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflows', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflows', 'DELETE')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'DELETE')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'DELETE')
          and not has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')
        end
      ) as phase2_grants_compatible,
      (
        exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_versions')
            and conname = 'workflow_versions_checksum_format'
            and pg_get_constraintdef(oid) = 'CHECK ((((((checksum)::text ~ ''^wf:v1:sha256:[0-9a-f]{64}$''::text) AND (executable_schema_version IS NULL) AND (executable_json IS NULL) AND (compatibility_release_epoch IS NULL)) OR (((checksum)::text ~ ''^wf:v2:sha256:[0-9a-f]{64}$''::text) AND (executable_schema_version IS NOT NULL) AND (executable_schema_version = 2) AND (executable_json IS NOT NULL) AND (jsonb_typeof(executable_json) = ''object''::text) AND (compatibility_release_epoch IS NOT NULL) AND (compatibility_release_epoch > 0))) IS TRUE))'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_versions')
            and conname = 'workflow_versions_executable_bounded'
            and pg_get_constraintdef(oid) = 'CHECK (((executable_json IS NULL) OR (octet_length((executable_json)::text) <= 1048576)))'
        )
      ) as phase3_schema_compatible,
      exists (
        select 1 from pg_policy policy
        where policy.polrelid = to_regclass('app.workflow_versions')
          and policy.polname = 'workflow_versions_worker_execution_read'
          and policy.polcmd = 'r'
          and cardinality(policy.polroles) = 1
          and policy.polroles[1] = (select oid from pg_roles where rolname = $2)
          and pg_get_expr(policy.polqual, policy.polrelid) = '(((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)) AND ((checksum)::text ~~ ''wf:v2:sha256:%''::text) AND (executable_schema_version = 2) AND (executable_json IS NOT NULL) AND (compatibility_release_epoch > 0))'
          and policy.polwithcheck is null
      ) as phase3_policy_compatible,
      (
        select
          not worker_role.rolsuper
          and not worker_role.rolbypassrls
          and not pg_has_role(worker_role.rolname, $1::name, 'MEMBER')
          and pg_get_userbyid((select relowner from pg_class where oid = to_regclass('app.workflow_versions'))) <> worker_role.rolname
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'id', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'workspace_id', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'workflow_id', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'version_number', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'schema_version', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'checksum', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'executable_schema_version', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'executable_json', 'SELECT')
          and has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'compatibility_release_epoch', 'SELECT')
          and not has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'graph_json', 'SELECT')
          and not has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'published_by', 'SELECT')
          and not has_column_privilege(worker_role.rolname, 'app.workflow_versions', 'published_at', 'SELECT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'SELECT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'INSERT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'UPDATE')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'DELETE')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'TRUNCATE')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'REFERENCES')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_versions', 'TRIGGER')
          and not has_table_privilege(worker_role.rolname, 'app.workflows', 'SELECT')
          and not has_table_privilege(worker_role.rolname, 'app.workflow_drafts', 'SELECT')
        from pg_roles worker_role
        where worker_role.rolname = $2
      ) as phase3_grants_compatible,
      (
        exists (
          select 1 from pg_attribute
          where attrelid = to_regclass('app.workflow_runs')
            and attname = 'input_ref' and atttypid = 'jsonb'::regtype
            and not attnotnull and not attisdropped
        )
        and (select count(*) = 22 from pg_attribute where attrelid = to_regclass('app.workflow_runs') and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_attribute where attrelid = to_regclass('app.run_checkpoints')
            and attname = 'workflow_version_id' and atttypid = 'uuid'::regtype
            and attnotnull and not attisdropped
        )
        and exists (
          select 1 from pg_attribute where attrelid = to_regclass('app.run_checkpoints')
            and attname = 'last_transition_fingerprint'
            and atttypid = 'character varying'::regtype
            and atttypmod = 68 and not attnotnull and not attisdropped
        )
        and (select count(*) = 12 from pg_attribute where attrelid = to_regclass('app.run_checkpoints') and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint where conrelid = to_regclass('app.workflow_runs')
            and conname = 'workflow_runs_workspace_version_identity_unique'
            and pg_get_constraintdef(oid) = 'UNIQUE (workspace_id, id, workflow_version_id)'
        )
        and exists (
          select 1 from pg_constraint where conrelid = to_regclass('app.run_checkpoints')
            and conname = 'run_checkpoints_transition_fingerprint_valid'
            and pg_get_constraintdef(oid) = 'CHECK (((last_transition_fingerprint IS NULL) OR ((last_transition_fingerprint)::text ~ ''^[0-9a-f]{64}$''::text)))'
        )
        and exists (
          select 1 from pg_constraint where conrelid = to_regclass('app.run_checkpoints')
            and conname = 'run_checkpoints_run_version_workspace_fk'
            and pg_get_constraintdef(oid) = 'FOREIGN KEY (workspace_id, workflow_run_id, workflow_version_id) REFERENCES app.workflow_runs(workspace_id, id, workflow_version_id) ON DELETE CASCADE'
        )
        and not exists (
          select 1 from (values
            ('run_events', 'run_events_payload_bounded', 'CHECK ((octet_length((payload)::text) <= 524288))'),
            ('workflow_runs', 'workflow_runs_input_ref_bounded', 'CHECK (((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304)))'),
            ('workflow_runs', 'workflow_runs_output_ref_bounded', 'CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304)))'),
            ('run_checkpoints', 'run_checkpoints_scheduler_state_bounded', 'CHECK ((octet_length((scheduler_state)::text) <= 4194304))'),
            ('node_runs', 'node_runs_input_ref_bounded', 'CHECK (((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304)))'),
            ('node_runs', 'node_runs_output_ref_bounded', 'CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304)))'),
            ('node_attempts', 'node_attempts_output_ref_bounded', 'CHECK (((output_ref IS NULL) OR (octet_length((output_ref)::text) <= 4194304)))')
          ) expected(table_name, constraint_name, definition)
          where not exists (
            select 1 from pg_constraint constraint_record
            where constraint_record.conrelid = to_regclass('app.' || expected.table_name)
              and constraint_record.conname = expected.constraint_name
              and pg_get_constraintdef(constraint_record.oid) = expected.definition
          )
        )
        and not exists (
          select 1 from (values
            ('workflow_runs', 'workflow_runs_workspace_scope'),
            ('run_events', 'run_events_workspace_scope'),
            ('run_checkpoints', 'run_checkpoints_workspace_scope'),
            ('node_runs', 'node_runs_workspace_scope'),
            ('node_attempts', 'node_attempts_workspace_scope')
          ) expected(table_name, policy_name)
          where (select count(*) from pg_policy where polrelid = to_regclass('app.' || expected.table_name)) <>
                case
                  when expected.table_name = 'node_runs' then 3
                  when expected.table_name = 'workflow_runs' then 3
                  else 1
                end
            or not exists (
              select 1 from pg_policy policy
              where policy.polrelid = to_regclass('app.' || expected.table_name)
                and policy.polname = expected.policy_name
                and policy.polcmd = '*'
                and cardinality(policy.polroles) = 2
                and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
                and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
                and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            )
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.artifacts')
            and policy.polname = 'artifacts_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 3
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and not exists (
          select 1 from (values ('workflow_runs', 'input_ref')) protected(table_name, column_name)
          where has_column_privilege($2, 'app.' || protected.table_name, protected.column_name, 'UPDATE')
        )
        and has_column_privilege($2, 'app.workflow_runs', 'input_ref', 'SELECT')
        and not has_column_privilege($2, 'app.workflow_runs', 'input_ref', 'INSERT')
        and not exists (
          select 1 from pg_policy policy, unnest(policy.polroles) runtime_role
          where policy.polrelid = to_regclass('app.workflow_runs')
            and policy.polname = 'workflow_runs_workspace_scope'
            and runtime_role <> (select oid from pg_roles where rolname = $2)
            and (
              not has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref', 'SELECT')
              or not has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref', 'INSERT')
              or has_column_privilege(pg_get_userbyid(runtime_role), 'app.workflow_runs', 'input_ref', 'UPDATE')
            )
        )
        and not exists (
          select 1 from (values
            ('workflow_runs'), ('run_checkpoints'), ('node_runs'), ('node_attempts')
          ) expected(table_name)
          where not exists (
            select 1 from pg_class table_record
            where table_record.oid = to_regclass('app.' || expected.table_name)
              and table_record.relrowsecurity and table_record.relforcerowsecurity
          )
        )
      ) as execution_values_compatible,
      (
        has_table_privilege($2, 'app.workflow_runs', 'SELECT')
        and not exists (
          select 1 from (values
            ('node_attempts_executor_failure_complete'),
            ('node_attempts_executor_failure_kind_valid'),
            ('node_attempts_executor_error_kind_valid'),
            ('node_attempts_retry_decision_valid'),
            ('node_attempts_executor_failure_only_failed')
          ) expected(constraint_name)
          where not exists (
            select 1 from pg_constraint constraint_record
            where constraint_record.conrelid=to_regclass('app.node_attempts')
              and constraint_record.conname=expected.constraint_name
          )
        )
        and (
          select pg_get_expr(constraint_record.conbin, constraint_record.conrelid)
          from pg_constraint constraint_record
          where constraint_record.conrelid = to_regclass('app.node_runs')
            and constraint_record.conname = 'node_runs_invocation_key_format'
        ) = $invocation_constraint$(((invocation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'::text) OR ((invocation_key)::text ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'::text))$invocation_constraint$
        and exists (
          select 1 from pg_constraint
          where conrelid=to_regclass('app.node_runs')
            and conname='node_runs_provider_dispatch_binding_format'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid=to_regclass('app.preview_attempts')
            and conname='preview_attempts_provider_dispatch_binding_format'
        )
        and has_table_privilege($2, 'app.run_checkpoints', 'SELECT')
        and has_table_privilege($2, 'app.run_events', 'SELECT')
        and has_table_privilege($2, 'app.node_runs', 'SELECT')
        and has_table_privilege($2, 'app.node_attempts', 'SELECT')
        and has_table_privilege($2, 'app.artifacts', 'SELECT')
        and has_table_privilege($2, 'app.outbox_events', 'SELECT')
        and has_table_privilege($2, 'app.inbox_receipts', 'SELECT')
        and has_table_privilege($2, 'app.inbox_receipts', 'INSERT')
        and has_column_privilege($2, 'app.inbox_receipts', 'completed_at', 'UPDATE')
        and has_table_privilege($2, 'app.transport_security_audit_facts', 'SELECT')
        and has_table_privilege($2, 'app.transport_security_audit_facts', 'INSERT')
        and has_table_privilege($2, 'app.node_runs', 'INSERT')
        and has_table_privilege($2, 'app.node_attempts', 'INSERT')
        and has_column_privilege($2, 'app.node_runs', 'provider_dispatch_binding', 'UPDATE')
        and has_column_privilege($2, 'app.preview_attempts', 'provider_dispatch_binding', 'UPDATE')
        and has_function_privilege(
          $2,
          'app.connection_dispatch_fence_current(uuid,uuid,text,text,uuid)',
          'EXECUTE'
        )
        and has_column_privilege($2, 'app.node_attempts', 'executor_failure_kind', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'executor_error_kind', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'executor_possibly_dispatched', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'retry_decision', 'UPDATE')
        and has_table_privilege($2, 'app.run_events', 'INSERT')
        and has_table_privilege($2, 'app.outbox_events', 'INSERT')
        and not has_table_privilege($2, 'app.workflow_runs', 'INSERT')
        and not has_table_privilege($2, 'app.run_checkpoints', 'INSERT')
        and not has_table_privilege($2, 'app.run_events', 'UPDATE')
        and not has_table_privilege($2, 'app.outbox_events', 'UPDATE')
        and not has_table_privilege($2, 'app.inbox_receipts', 'UPDATE')
        and not has_table_privilege($2, 'app.transport_security_audit_facts', 'UPDATE')
        and not exists (
          select 1 from information_schema.column_privileges privilege
          where privilege.table_schema='app'
            and privilege.table_name='inbox_receipts'
            and privilege.grantee=$2
            and privilege.privilege_type='UPDATE'
            and privilege.column_name <> 'completed_at'
        )
        and not exists (
          select 1 from (values
            ('workflow_runs'), ('run_checkpoints'), ('run_events'),
            ('node_runs'), ('node_attempts'), ('artifacts'), ('outbox_events'),
            ('inbox_receipts'), ('transport_security_audit_facts')
          ) protected(table_name)
          join pg_class relation
            on relation.oid = to_regclass('app.' || protected.table_name)
          where not relation.relrowsecurity or not relation.relforcerowsecurity
        )
        and not exists (
          select 1
          from information_schema.column_privileges privilege
          where privilege.table_schema='app'
            and privilege.grantee=$2
            and privilege.privilege_type='UPDATE'
            and privilege.table_name in (
              'workflow_runs', 'run_checkpoints', 'node_runs', 'node_attempts'
            )
            and not (
              (privilege.table_name='workflow_runs' and privilege.column_name in (
                'status','started_at','completed_at','output_ref','error_summary','updated_at',
                'deadline_wakeup_at'
              ))
              or (privilege.table_name='run_checkpoints' and privilege.column_name in (
                'revision','engine_version','scheduler_state','resume_at',
                'resume_lease_owner','resume_lease_token','resume_lease_expires_at',
                'updated_at','last_transition_fingerprint'
              ))
              or (privilege.table_name='node_runs' and privilege.column_name in (
                'status','output_ref','current_attempt_id','current_attempt_number',
                 'resume_at','retry_due_at','safe_error_code','updated_at',
                  'started_at','completed_at','due_wakeup_at','control_kind','wait_kind',
                  'provider_dispatch_binding'
              ))
              or (privilege.table_name='node_attempts' and privilege.column_name in (
                'status','lease_owner','lease_expires_at','fence_token',
                 'dispatch_marked_at','output_ref','safe_error_code','error_summary',
                 'reconciliation_ref','updated_at','started_at','completed_at',
                 'executor_failure_kind','executor_error_kind',
                 'executor_possibly_dispatched','retry_decision'
               ))
            )
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.outbox_events')
            and policy.polname = 'outbox_events_tenant_insert'
            and policy.polcmd = 'a'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and policy.polqual is null
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.outbox_events')
            and policy.polname = 'outbox_events_tenant_select'
            and policy.polcmd = 'r'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and policy.polwithcheck is null
        )
        and not exists (
          select 1 from (values
            ('inbox_receipts', 'inbox_receipts_workspace_scope'),
            ('transport_security_audit_facts', 'transport_security_audit_facts_workspace_scope')
          ) expected(table_name, policy_name)
          where not exists (
            select 1 from pg_policy policy
            where policy.polrelid = to_regclass('app.' || expected.table_name)
              and policy.polname = expected.policy_name
              and policy.polcmd = '*'
              and cardinality(policy.polroles) = 2
              and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
              and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
              and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
          )
        )
        and has_column_privilege($2, 'app.workflow_runs', 'status', 'UPDATE')
        and not exists (
          select 1 from (values
            ('workflow_runs', 'started_at'),
            ('workflow_runs', 'completed_at'),
            ('workflow_runs', 'updated_at'),
            ('workflow_runs', 'deadline_wakeup_at'),
            ('run_checkpoints', 'engine_version'),
            ('run_checkpoints', 'scheduler_state'),
            ('run_checkpoints', 'last_transition_fingerprint'),
            ('run_checkpoints', 'resume_at'),
            ('run_checkpoints', 'resume_lease_owner'),
            ('run_checkpoints', 'resume_lease_token'),
            ('run_checkpoints', 'resume_lease_expires_at'),
            ('run_checkpoints', 'updated_at'),
            ('node_runs', 'current_attempt_id'),
            ('node_runs', 'current_attempt_number'),
            ('node_runs', 'resume_at'),
             ('node_runs', 'retry_due_at'),
             ('node_runs', 'due_wakeup_at'),
             ('node_runs', 'control_kind'),
             ('node_runs', 'wait_kind'),
            ('node_runs', 'completed_at'),
            ('node_runs', 'safe_error_code'),
            ('node_runs', 'updated_at')
          ) required(table_name, column_name)
          where not has_column_privilege(
            $2,
            'app.' || required.table_name,
            required.column_name,
            'UPDATE'
          )
        )
        and has_column_privilege($2, 'app.run_checkpoints', 'revision', 'UPDATE')
        and has_column_privilege($2, 'app.run_checkpoints', 'scheduler_state', 'UPDATE')
        and has_column_privilege($2, 'app.node_runs', 'status', 'UPDATE')
        and has_column_privilege($2, 'app.node_attempts', 'status', 'UPDATE')
        and not has_column_privilege($2, 'app.run_checkpoints', 'workflow_version_id', 'UPDATE')
        and not exists (
          select 1 from (values
            ('workflow_runs'), ('run_checkpoints'), ('run_events'),
            ('node_runs'), ('node_attempts'), ('artifacts'), ('outbox_events'),
            ('inbox_receipts'), ('transport_security_audit_facts')
          ) protected(table_name)
          where has_table_privilege($2, 'app.' || protected.table_name, 'DELETE')
             or has_table_privilege($2, 'app.' || protected.table_name, 'TRUNCATE')
             or has_table_privilege($2, 'app.' || protected.table_name, 'REFERENCES')
             or has_table_privilege($2, 'app.' || protected.table_name, 'TRIGGER')
        )
      ) as coordinator_run_store_compatible,
      (
        (select count(*) = 13 from pg_attribute
         where attrelid = to_regclass('app.connections')
           and attnum > 0 and not attisdropped)
        and (select count(*) = 11 from pg_attribute
             where attrelid = to_regclass('app.connection_secret_versions')
               and attnum > 0 and not attisdropped)
        and (select count(*) = 10 from pg_attribute
             where attrelid = to_regclass('app.connection_events')
               and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.connections')
            and conname = 'connections_current_secret_same_connection_fk'
            and contype = 'f' and condeferrable and condeferred
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.connections')
            and conname = 'connections_auth_type_valid'
            and pg_get_constraintdef(oid) = 'CHECK (((auth_type)::text = ANY ((ARRAY[''http_headers''::character varying, ''slack_bot_token''::character varying, ''resend_api_key''::character varying])::text[])))'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.connection_secret_versions')
            and tgname = 'connection_secret_versions_immutable'
            and not tgisinternal
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.connection_events')
            and tgname = 'connection_events_immutable'
            and not tgisinternal
        )
        and not exists (
          select 1 from (values
            ('connections'),
            ('connection_secret_versions'),
            ('connection_events')
          ) protected(table_name)
          join pg_class protected_class
            on protected_class.oid = to_regclass('app.' || protected.table_name)
          where not protected_class.relrowsecurity
             or not protected_class.relforcerowsecurity
             or pg_get_userbyid(protected_class.relowner) <> $1
             or has_table_privilege(current_user, protected_class.oid, 'DELETE')
             or has_table_privilege(current_user, protected_class.oid, 'TRUNCATE')
             or has_table_privilege(current_user, protected_class.oid, 'REFERENCES')
             or has_table_privilege(current_user, protected_class.oid, 'TRIGGER')
        )
        and case when current_user = $2 then
          has_table_privilege(current_user, 'app.connections', 'SELECT')
          and not has_table_privilege(current_user, 'app.connections', 'INSERT')
          and has_column_privilege(current_user, 'app.connections', 'status', 'UPDATE')
          and has_column_privilege(current_user, 'app.connections', 'last_tested_at', 'UPDATE')
          and not has_column_privilege(current_user, 'app.connections', 'current_secret_version_id', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_secret_versions', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_events', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_events', 'UPDATE')
        when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.connections')
            and policy.polname = 'connections_workspace_scope'
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.connections', 'SELECT')
          and has_table_privilege(current_user, 'app.connections', 'INSERT')
          and has_column_privilege(current_user, 'app.connections', 'current_secret_version_id', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_secret_versions', 'SELECT')
          and has_table_privilege(current_user, 'app.connection_secret_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_events', 'SELECT')
          and has_table_privilege(current_user, 'app.connection_events', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_events', 'UPDATE')
        else
          not has_table_privilege(current_user, 'app.connections', 'SELECT')
          and not has_table_privilege(current_user, 'app.connections', 'INSERT')
          and not has_table_privilege(current_user, 'app.connections', 'UPDATE')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'UPDATE')
          and not has_table_privilege(current_user, 'app.connection_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_events', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_events', 'UPDATE')
        end
      ) as phase4_connections_compatible,
      (
        (select count(*) = 5 from pg_attribute
         where attrelid = to_regclass('app.workflow_integration_usage')
           and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_integration_usage')
            and conname = 'workflow_integration_usage_identity_pk'
            and contype = 'p'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_integration_usage')
            and conname = 'workflow_integration_usage_version_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_integration_usage')
            and conname = 'workflow_integration_usage_connection_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_class protected
          where protected.oid = to_regclass('app.workflow_integration_usage')
            and protected.relrowsecurity
            and protected.relforcerowsecurity
            and pg_get_userbyid(protected.relowner) = $1
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.workflow_integration_usage')
            and policy.polname = 'workflow_integration_usage_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and not ((select oid from pg_roles where rolname = $2) = any(policy.polroles))
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and case when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.workflow_integration_usage')
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.workflow_integration_usage', 'SELECT')
          and has_table_privilege(current_user, 'app.workflow_integration_usage', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'UPDATE')
          and has_table_privilege(current_user, 'app.workflow_integration_usage', 'DELETE')
        else
          not has_table_privilege(current_user, 'app.workflow_integration_usage', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'DELETE')
        end
        and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'TRUNCATE')
        and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'REFERENCES')
        and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'TRIGGER')
      ) as phase4_integration_usage_compatible,
      (
        (select count(*) = 5 from pg_attribute
         where attrelid = to_regclass('app.artifact_links')
           and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.artifact_links')
            and conname = 'artifact_links_identity_unique'
            and contype = 'p'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.artifact_links')
            and conname = 'artifact_links_artifact_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.artifact_links')
            and conname = 'artifact_links_preview_run_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.artifact_links')
            and tgname = 'artifact_link_preview_retention'
            and not tgisinternal
        )
        and exists (
          select 1 from pg_proc routine
          where routine.oid = to_regprocedure('app.complete_preview_cleanup(uuid,uuid)')
            and routine.prosecdef
            and pg_get_userbyid(routine.proowner) = $1
            and has_function_privilege($2, routine.oid, 'EXECUTE')
        )
        and exists (
          select 1 from pg_class protected
          where protected.oid = to_regclass('app.artifact_links')
            and protected.relrowsecurity
            and protected.relforcerowsecurity
            and pg_get_userbyid(protected.relowner) = $1
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.artifact_links')
            and policy.polname = 'artifact_links_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 3
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and case when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.artifact_links')
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.artifact_links', 'SELECT')
          and case when current_user = $2 then
            has_table_privilege(current_user, 'app.artifact_links', 'INSERT')
          else
            not has_table_privilege(current_user, 'app.artifact_links', 'INSERT')
          end
        else
          not has_table_privilege(current_user, 'app.artifact_links', 'SELECT')
          and not has_table_privilege(current_user, 'app.artifact_links', 'INSERT')
        end
        and not has_table_privilege(current_user, 'app.artifact_links', 'UPDATE')
        and not has_table_privilege(current_user, 'app.artifact_links', 'DELETE')
        and not has_table_privilege(current_user, 'app.artifact_links', 'TRUNCATE')
        and not has_table_privilege(current_user, 'app.artifact_links', 'REFERENCES')
        and not has_table_privilege(current_user, 'app.artifact_links', 'TRIGGER')
      ) as phase4_preview_artifacts_compatible,
      (
        (select count(*) = 9 from pg_attribute
         where attrelid = to_regclass('app.usage_events')
           and attnum > 0 and not attisdropped)
        and not exists (
          select 1
          from (values
            ('id', 'uuid'),
            ('workspace_id', 'uuid'),
            ('category', 'character varying(64)'),
            ('quantity', 'bigint'),
            ('resource_type', 'character varying(64)'),
            ('resource_id', 'uuid'),
            ('idempotency_key', 'character varying(128)'),
            ('metadata', 'jsonb'),
            ('occurred_at', 'timestamp with time zone')
          ) expected(attname, type_name)
          where not exists (
            select 1 from pg_attribute attribute
            where attribute.attrelid = to_regclass('app.usage_events')
              and attribute.attname = expected.attname
              and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
              and attribute.attnotnull
              and not attribute.attisdropped
          )
        )
        and exists (
          select 1 from pg_attribute attribute
          join pg_attrdef default_value
            on default_value.adrelid = attribute.attrelid
           and default_value.adnum = attribute.attnum
          where attribute.attrelid = to_regclass('app.usage_events')
            and attribute.attname = 'metadata'
            and pg_get_expr(default_value.adbin, default_value.adrelid) = '''{}''::jsonb'
        )
        and exists (
          select 1 from pg_attribute attribute
          join pg_attrdef default_value
            on default_value.adrelid = attribute.attrelid
           and default_value.adnum = attribute.attnum
          where attribute.attrelid = to_regclass('app.usage_events')
            and attribute.attname = 'occurred_at'
            and pg_get_expr(default_value.adbin, default_value.adrelid) = 'clock_timestamp()'
        )
        and not exists (
          select 1
          from (values
            ('usage_events_pkey', 'p', true, 'PRIMARY KEY (id)'),
            ('usage_events_workspace_fk', 'f', true, 'FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT'),
            ('usage_events_category_format', 'c', true, 'CHECK (((category)::text ~ ''^[a-z][a-z0-9._:-]{0,63}$''::text))'),
            ('usage_events_quantity_positive', 'c', true, 'CHECK ((quantity > 0))'),
            ('usage_events_resource_type_format', 'c', true, 'CHECK (((resource_type)::text ~ ''^[a-z][a-z0-9._:-]{0,63}$''::text))'),
            ('usage_events_idempotency_key_format', 'c', true, 'CHECK (((idempotency_key)::text ~ ''^[A-Za-z0-9._:-]{1,128}$''::text))'),
            ('usage_events_metadata_bounded', 'c', true, 'CHECK ((octet_length((metadata)::text) <= 4096))'),
            ('usage_events_workspace_idempotency_unique', 'u', true, 'UNIQUE (workspace_id, idempotency_key)'),
            ('usage_events_preview_uuid_v7', 'c', false, 'CHECK ((((category)::text <> ''preview_execution''::text) OR (uuid_extract_version(id) = 7))) NOT VALID')
          ) expected(conname, contype, convalidated, definition)
          where not exists (
            select 1 from pg_constraint constraint_record
            where constraint_record.conrelid = to_regclass('app.usage_events')
              and constraint_record.conname = expected.conname
              and constraint_record.contype = expected.contype::char
              and constraint_record.convalidated = expected.convalidated
              and pg_get_constraintdef(constraint_record.oid) = expected.definition
          )
        )
        and not exists (
          select 1
          from (values
            ('usage_events_workspace_period_idx', 'CREATE INDEX usage_events_workspace_period_idx ON app.usage_events USING btree (workspace_id, occurred_at DESC, id)'),
            ('usage_events_resource_idx', 'CREATE INDEX usage_events_resource_idx ON app.usage_events USING btree (workspace_id, resource_type, resource_id, id)')
          ) expected(indexname, definition)
          where not exists (
            select 1 from pg_indexes index_record
            where index_record.schemaname = 'app'
              and index_record.tablename = 'usage_events'
              and index_record.indexname = expected.indexname
              and index_record.indexdef = expected.definition
          )
        )
        and not exists (
          select 1
          from (values
            ('request_id', 'character varying(128)'),
            ('trace_id', 'character varying(128)'),
            ('provider_key', 'character varying(64)'),
            ('operation_key', 'character varying(128)')
          ) expected(attname, type_name)
          where not exists (
            select 1 from pg_attribute attribute
            where attribute.attrelid = to_regclass('app.preview_runs')
              and attribute.attname = expected.attname
              and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
              and not attribute.attnotnull
              and not attribute.attisdropped
          )
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.preview_runs')
            and conname = 'preview_runs_integration_identity_consistent'
            and contype = 'c'
            and convalidated
            and pg_get_constraintdef(oid) = 'CHECK ((((provider_key IS NULL) AND (operation_key IS NULL)) OR (((provider_key)::text ~ ''^[a-z][a-z0-9._:-]{0,63}$''::text) AND ((operation_key)::text ~ ''^[a-z][a-z0-9._:-]{0,127}$''::text))))'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.audit_events')
            and conname = 'audit_events_preview_terminal_uuid_v7'
            and contype = 'c'
            and not convalidated
            and pg_get_constraintdef(oid) = 'CHECK ((((action)::text <> ''preview.execution_terminal''::text) OR (uuid_extract_version(id) = 7))) NOT VALID'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.preview_runs')
            and tgname = 'preview_run_pins_immutable'
            and not tgisinternal
            and tgenabled = 'O'
            and pg_get_triggerdef(oid) = 'CREATE TRIGGER preview_run_pins_immutable BEFORE UPDATE ON app.preview_runs FOR EACH ROW EXECUTE FUNCTION app.reject_preview_run_pin_change()'
        )
        and exists (
          select 1 from pg_proc
          where oid = to_regprocedure('app.reject_preview_run_pin_change()')
            and md5(prosrc) = 'fd27005cfd2f52a46881a99549bf609c'
            and pg_get_userbyid(proowner) = $1
            and prolang = (select oid from pg_language where lanname = 'plpgsql')
            and proconfig = array['search_path=pg_catalog, pg_temp']::text[]
            and not prosecdef
        )
        and exists (
          select 1 from pg_class protected
          where protected.oid = to_regclass('app.usage_events')
            and protected.relrowsecurity
            and protected.relforcerowsecurity
            and pg_get_userbyid(protected.relowner) = $1
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.usage_events')
            and policy.polname = 'usage_events_workspace_select'
            and policy.polcmd = 'r'
            and cardinality(policy.polroles) = 3
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and policy.polwithcheck is null
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.usage_events')
            and policy.polname = 'usage_events_workspace_insert'
            and policy.polcmd = 'a'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and policy.polqual is null
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.audit_events')
            and policy.polname = 'audit_events_workspace_insert'
            and policy.polcmd = 'a'
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and has_table_privilege($2, 'app.audit_events', 'INSERT')
        and has_table_privilege($2, 'app.usage_events', 'SELECT')
        and has_table_privilege($2, 'app.usage_events', 'INSERT')
        and not has_table_privilege($2, 'app.usage_events', 'UPDATE')
        and not has_table_privilege($2, 'app.usage_events', 'DELETE')
        and not has_table_privilege($2, 'app.usage_events', 'TRUNCATE')
        and not has_table_privilege($2, 'app.usage_events', 'REFERENCES')
        and not has_table_privilege($2, 'app.usage_events', 'TRIGGER')
        and case when current_user = $2 then
          has_table_privilege(current_user, 'app.audit_events', 'INSERT')
          and has_table_privilege(current_user, 'app.usage_events', 'SELECT')
          and has_table_privilege(current_user, 'app.usage_events', 'INSERT')
        when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.usage_events')
            and policy.polname = 'usage_events_workspace_select'
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.usage_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.usage_events', 'INSERT')
        else
          not has_table_privilege(current_user, 'app.usage_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.usage_events', 'INSERT')
        end
        and not has_table_privilege(current_user, 'app.usage_events', 'UPDATE')
        and not has_table_privilege(current_user, 'app.usage_events', 'DELETE')
        and not has_table_privilege(current_user, 'app.usage_events', 'TRUNCATE')
        and not has_table_privilege(current_user, 'app.usage_events', 'REFERENCES')
        and not has_table_privilege(current_user, 'app.usage_events', 'TRIGGER')
      ) as phase4_preview_terminal_facts_compatible,
      (
        exists (
          select 1 from pg_attribute
          where attrelid = 'app.node_runs'::regclass
            and attname = 'due_wakeup_at' and not attisdropped
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = 'app.node_runs'::regclass
            and conname = 'node_runs_due_wakeup_consistent'
        )
        and exists (
          select 1 from pg_proc
          where oid = to_regprocedure('app.claim_due_node_run_wakeups(integer)')
            and prosecdef
            and pg_get_userbyid(proowner) = $1
            and proconfig = array['search_path=pg_catalog, pg_temp']::text[]
        )
        and has_function_privilege($2, 'app.claim_due_node_run_wakeups(integer)', 'EXECUTE')
        and has_column_privilege($2, 'app.node_runs', 'due_wakeup_at', 'UPDATE')
        and not exists (
          select 1
          from pg_proc function_record,
               lateral aclexplode(coalesce(
                 function_record.proacl,
                 acldefault('f', function_record.proowner)
               )) privilege
          where function_record.oid =
                to_regprocedure('app.claim_due_node_run_wakeups(integer)')
            and privilege.privilege_type = 'EXECUTE'
            and privilege.grantee not in (
              (select oid from pg_roles where rolname = $1),
              (select oid from pg_roles where rolname = $2)
            )
        )
        and exists (
          select 1 from pg_policy
          where polrelid = 'app.node_runs'::regclass
            and polname = 'node_runs_due_wakeup_owner_select'
        )
        and exists (
          select 1 from pg_policy
          where polrelid = 'app.node_runs'::regclass
            and polname = 'node_runs_due_wakeup_owner_update'
        )
        and exists (
          select 1 from pg_policy
          where polrelid = 'app.outbox_events'::regclass
            and polname = 'outbox_events_due_wakeup_owner_insert'
        )
      ) as due_node_wakeups_compatible,
      (
        exists (
          select 1 from pg_attribute
          where attrelid='app.node_runs'::regclass
            and attname='wait_kind' and not attisdropped
        )
        and exists (
          select 1 from pg_attribute attribute
          join pg_attrdef default_record
            on default_record.adrelid=attribute.attrelid
           and default_record.adnum=attribute.attnum
          where attribute.attrelid='app.node_attempts'::regclass
            and attribute.attname='admission_kind'
            and attribute.attnotnull and not attribute.attisdropped
            and pg_get_expr(default_record.adbin, default_record.adrelid) =
              '''execute''::character varying'
        )
        and exists (
          select 1 from pg_attribute
          where attrelid='app.workflow_runs'::regclass
            and attname='deadline_wakeup_at' and not attisdropped
        )
        and not exists (
          select 1 from (values
            ('node_runs', 'node_runs_wait_kind_valid'),
            ('node_runs', 'node_runs_wait_state_valid'),
            ('node_attempts', 'node_attempts_admission_kind_valid'),
            ('workflow_runs', 'workflow_runs_deadline_wakeup_consistent')
          ) expected(table_name, constraint_name)
          where not exists (
            select 1 from pg_constraint
            where conrelid=to_regclass('app.' || expected.table_name)
              and conname=expected.constraint_name
          )
        )
        and exists (
          select 1 from pg_proc
          where oid=to_regprocedure('app.claim_due_workflow_run_deadlines(integer)')
            and prosecdef
            and pg_get_userbyid(proowner)=$1
            and proconfig=array['search_path=pg_catalog, pg_temp']::text[]
        )
        and has_function_privilege($2, 'app.claim_due_workflow_run_deadlines(integer)', 'EXECUTE')
        and has_column_privilege($2, 'app.node_runs', 'wait_kind', 'UPDATE')
        and has_column_privilege($2, 'app.workflow_runs', 'deadline_wakeup_at', 'UPDATE')
        and not exists (
          select 1 from pg_proc function_record,
            lateral aclexplode(coalesce(
              function_record.proacl,
              acldefault('f', function_record.proowner)
            )) privilege
          where function_record.oid=to_regprocedure('app.claim_due_workflow_run_deadlines(integer)')
            and privilege.privilege_type='EXECUTE'
            and privilege.grantee not in (
              (select oid from pg_roles where rolname=$1),
              (select oid from pg_roles where rolname=$2)
            )
        )
        and exists (
          select 1 from pg_policy
          where polrelid='app.workflow_runs'::regclass
            and polname='workflow_runs_deadline_wakeup_owner_select'
        )
        and exists (
          select 1 from pg_policy
          where polrelid='app.workflow_runs'::regclass
            and polname='workflow_runs_deadline_wakeup_owner_update'
        )
      ) as durable_wait_compatible,
      (
        to_regclass('app.run_failure_notification_intents') is not null
        and to_regclass('app.run_failure_notification_audit_facts') is not null
        and (select relrowsecurity and relforcerowsecurity
             from pg_class where oid=to_regclass('app.run_failure_notification_intents'))
        and (select relrowsecurity and relforcerowsecurity
             from pg_class where oid=to_regclass('app.run_failure_notification_audit_facts'))
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.run_failure_notification_intents')
            and conname='run_failure_notification_intents_logical_unique')
        and exists (select 1 from pg_constraint
          where conrelid=to_regclass('app.run_failure_notification_intents')
            and conname='run_failure_notification_intents_context_bounded')
        and exists (select 1 from pg_policy
          where polrelid=to_regclass('app.run_failure_notification_intents')
            and polname='run_failure_notification_intents_workspace_scope')
        and has_table_privilege($2, 'app.run_failure_notification_intents', 'SELECT')
        and has_table_privilege($2, 'app.run_failure_notification_intents', 'INSERT')
        and has_column_privilege($2, 'app.run_failure_notification_intents', 'status', 'UPDATE')
        and not has_column_privilege($2, 'app.run_failure_notification_intents', 'context', 'UPDATE')
        and not has_table_privilege($2, 'app.run_failure_notification_intents', 'DELETE')
        and has_table_privilege($2, 'app.run_failure_notification_audit_facts', 'INSERT')
        and not has_table_privilege($2, 'app.run_failure_notification_audit_facts', 'UPDATE')
        and not has_table_privilege($2, 'app.run_failure_notification_audit_facts', 'DELETE')
      ) as failure_notification_compatible,
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
    [options.ownerRole, options.workerRuntimeRole ?? 'pertexo_worker'],
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
  if (!row.oidc_capacity_compatible) {
    throw new Error('OIDC login transaction capacity guard is incompatible');
  }
  if (!row.phase2_schema_compatible) {
    throw new Error('Workflow authoring schema is incompatible');
  }
  if (!row.phase2_policy_compatible) {
    throw new Error('Workflow authoring row-level security is incompatible');
  }
  if (!row.phase2_grants_compatible) {
    throw new Error('Workflow authoring runtime grants are incompatible');
  }
  if (!row.phase3_schema_compatible) {
    throw new Error('Published workflow execution schema is incompatible');
  }
  if (!row.phase3_policy_compatible) {
    throw new Error(
      'Published workflow execution row-level security is incompatible',
    );
  }
  if (!row.phase3_grants_compatible) {
    throw new Error('Published workflow execution grants are incompatible');
  }
  if (!row.execution_values_compatible) {
    throw new Error('Execution value persistence is incompatible');
  }
  if (!row.coordinator_run_store_compatible) {
    throw new Error('Coordinator RunStore grants are incompatible');
  }
  if (!row.due_node_wakeups_compatible) {
    throw new Error('Due node wakeup authority is incompatible');
  }
  if (!row.durable_wait_compatible) {
    throw new Error('Durable Wait authority is incompatible');
  }
  if (!row.failure_notification_compatible) {
    throw new Error('Run failure notification persistence is incompatible');
  }
  if (!row.phase4_connections_compatible) {
    throw new Error('Connection persistence schema or grants are incompatible');
  }
  if (!row.phase4_integration_usage_compatible) {
    throw new Error(
      'Workflow integration usage schema or grants are incompatible',
    );
  }
  if (!row.phase4_preview_artifacts_compatible) {
    throw new Error(
      'Preview artifact ownership schema or grants are incompatible',
    );
  }
  if (!row.phase4_preview_terminal_facts_compatible) {
    throw new Error('Preview terminal fact schema or grants are incompatible');
  }
  const hasProtectedTableAccess =
    row.can_select || row.can_insert || row.can_update || row.can_delete;
  if (
    (hasProtectedTableAccess &&
      (!row.can_select ||
        !row.can_insert ||
        !row.can_update ||
        !row.can_delete)) ||
    row.can_truncate ||
    row.can_references ||
    row.can_trigger
  ) {
    throw new Error('Runtime database grants are incompatible');
  }
  if (row.rolsuper || row.rolbypassrls || row.owner_member) {
    throw new Error('Runtime database role is privileged');
  }

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
