import type { Pool } from 'pg';

export const EXPECTED_MIGRATION_HEAD = '0013_published_workflow_execution.sql';
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
  postgres_major: number;
  relforcerowsecurity: boolean;
  relrowsecurity: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  schema_compatible: boolean;
}

type ReadinessOptions = Readonly<{
  ownerRole: string;
  workerRuntimeRole?: string;
  supportedGraphSchemaVersions?: readonly number[];
  supportedChecksumAlgorithms?: readonly string[];
  supportedExecutableSchemaVersions?: readonly number[];
}>;

export async function checkDatabaseReadiness(
  pool: Pool,
  options: ReadinessOptions = { ownerRole: 'pertexo_owner' },
): Promise<DatabaseReadiness> {
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

  return Object.freeze({
    migrationHead: row.migration_head,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}
