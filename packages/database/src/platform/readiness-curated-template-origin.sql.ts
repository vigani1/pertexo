// ADR063: exact compatible/off image inventory; selection flags are owner mutable.
// No readiness check here enables either writer or infers provider safety.
export const READINESS_CURATED_TEMPLATE_ORIGIN_SQL = `(
  (select count(*)=4 from (values
    ('app.guard_curated_template_descriptor()','6e0fd4efae62132ea0312d9d99496039',false,'v',false),
    ('app.lock_curated_template_descriptor(text,integer)','f9f5e6053b93a8900abe09fe5e624bba',true,'v',true),
    ('app.curated_https_endpoint_valid(text)','dde56c7e4aca9c64bd745c80be97e8d5',false,'i',false),
    ('app.verify_curated_template_origin(jsonb,jsonb,text)','e7a60281a1a81b56a085ff72c4bf8bf4',true,'v',false)
  ) expected(signature,body_hash,definer,volatility,api_execute)
    join pg_proc p on p.oid=to_regprocedure(expected.signature)
    where p.proowner=(select oid from pg_roles where rolname=$1)
      and p.prosecdef=expected.definer and p.provolatile::text=expected.volatility
      and md5(p.prosrc)=expected.body_hash
      and p.proconfig=case when expected.definer
        then array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
        else array['search_path=pg_catalog, pg_temp']::text[] end
      and has_function_privilege($3,p.oid,'EXECUTE')=expected.api_execute
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee<>p.proowner and (not expected.api_execute
          or a.grantee<>(select oid from pg_roles where rolname=$3)
          or a.privilege_type<>'EXECUTE' or a.is_grantable)))
  and (select count(*)=3 from pg_class c where c.oid=any(array[
      to_regclass('app.curated_template_rollout'),to_regclass('app.curated_template_descriptors'),
      to_regclass('app.workflow_template_origins')])
    and c.relowner=(select oid from pg_roles where rolname=$1)
    and has_table_privilege($3,c.oid,'SELECT')
    and not has_table_privilege($3,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where a.grantee<>c.relowner and (a.grantee<>(select oid from pg_roles where rolname=$3)
        or a.privilege_type<>'SELECT' or a.is_grantable))
    and not exists(select 1 from pg_attribute column_grant,
      lateral aclexplode(column_grant.attacl) a
      where column_grant.attrelid=c.oid and a.grantee<>c.relowner
        and (c.relname<>'curated_template_rollout' or column_grant.attname<>'singleton'
          or a.grantee<>(select oid from pg_roles where rolname=$3)
          or a.privilege_type<>'UPDATE' or a.is_grantable)))
  and has_column_privilege($3,'app.curated_template_rollout','singleton','UPDATE')
  and not has_table_privilege($2,'app.curated_template_descriptors','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and (select count(*)=13 from pg_attribute a where a.attrelid=any(array[
    to_regclass('app.curated_template_rollout'),to_regclass('app.curated_template_descriptors'),
    to_regclass('app.workflow_template_origins')]) and a.attnum>0 and not a.attisdropped and a.attnotnull)
  and (select count(*)=8 from pg_constraint c where c.conrelid=any(array[
    to_regclass('app.curated_template_descriptors'),to_regclass('app.workflow_template_origins')]) and c.contype='c')
  and (select count(*)=8 from (values
    ('curated_template_descriptors','curated_template_descriptors_base_manifest_check',
      $constraint$CHECK ((((octet_length(base_manifest) >= 1) AND (octet_length(base_manifest) <= 2097152)) AND (jsonb_typeof((base_manifest)::jsonb) = 'object'::text)))$constraint$),
    ('curated_template_descriptors','curated_template_descriptors_check',
      $constraint$CHECK (((base_manifest_digest ~ '^[0-9a-f]{64}$'::text) AND ((base_manifest_digest)::text = encode(sha256(((convert_to('pertexo.workflow.portable.manifest.v1'::text, 'UTF8'::name) || decode('00'::text, 'hex'::text)) || convert_to(base_manifest, 'UTF8'::name))), 'hex'::text))))$constraint$),
    ('curated_template_descriptors','curated_template_descriptors_schema_version_check',
      $constraint$CHECK ((schema_version = 1))$constraint$),
    ('curated_template_descriptors','curated_template_descriptors_setup_targets_check',
      $constraint$CHECK (((jsonb_typeof(setup_targets) = 'array'::text) AND (jsonb_array_length(setup_targets) <= 16)))$constraint$),
    ('curated_template_descriptors','curated_template_descriptors_supported_profile_check',
      $constraint$CHECK ((supported_profile = 'validate_activation'::text))$constraint$),
    ('curated_template_descriptors','curated_template_descriptors_template_id_check',
      $constraint$CHECK (((template_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND ((octet_length(template_id) >= 1) AND (octet_length(template_id) <= 64))))$constraint$),
    ('curated_template_descriptors','curated_template_descriptors_template_version_check',
      $constraint$CHECK ((template_version > 0))$constraint$),
    ('workflow_template_origins','workflow_template_origins_origin_check',
      $constraint$CHECK (((jsonb_typeof(origin) = 'object'::text) AND (octet_length((origin)::text) <= 512)))$constraint$)
  ) expected(table_name,constraint_name,definition)
    join pg_constraint c on c.conrelid=to_regclass('app.'||expected.table_name) and c.conname=expected.constraint_name
    where c.contype='c' and c.convalidated and pg_get_constraintdef(c.oid)=expected.definition)
  and (select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum)
    from pg_attribute a where a.attrelid=to_regclass('app.curated_template_rollout') and a.attnum>0 and not a.attisdropped)
    =array['singleton:boolean','import_enabled:boolean']::text[]
  and exists(select 1 from pg_constraint c where c.conrelid=to_regclass('app.curated_template_rollout')
    and c.contype='p' and pg_get_constraintdef(c.oid)='PRIMARY KEY (singleton)')
  and exists(select 1 from pg_constraint c where c.conrelid=to_regclass('app.curated_template_rollout')
    and c.contype='c' and pg_get_constraintdef(c.oid)='CHECK (singleton)')
  and (select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum)
    from pg_attribute a where a.attrelid=to_regclass('app.curated_template_descriptors') and a.attnum>0 and not a.attisdropped)
    =array['template_id:text','template_version:integer','schema_version:integer','base_manifest:text','base_manifest_digest:character(64)','setup_targets:jsonb','supported_profile:text','selection_enabled:boolean']::text[]
  and exists(select 1 from pg_constraint c where c.conrelid=to_regclass('app.curated_template_descriptors')
    and c.contype='p' and pg_get_constraintdef(c.oid)='PRIMARY KEY (template_id, template_version)')
  and exists(select 1 from pg_proc p where p.oid=to_regprocedure('app.curated_template_inventory_matches(text)')
    and p.proowner=(select oid from pg_roles where rolname=$1) and p.prosecdef and p.provolatile='s'
    and md5(p.prosrc)='c24b77c0f824bd4701e2afa88404cd90'
    and p.proconfig=array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
    and has_function_privilege($3,p.oid,'EXECUTE') and has_function_privilege($2,p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee<>p.proowner and (a.grantee not in ((select oid from pg_roles where rolname=$2),
        (select oid from pg_roles where rolname=$3)) or a.privilege_type<>'EXECUTE' or a.is_grantable)))
  -- The API/worker-only data witness is queried separately on the validated
  -- caller's connection. Even a CASE reference can require helper EXECUTE on
  -- PostgreSQL; other roles must retain these pins without invoking it.
  and exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('app.curated_template_descriptors')
    and t.tgname='curated_template_descriptor_immutable' and not t.tgisinternal
    and t.tgenabled='O' and t.tgtype=27
    and t.tgfoid=to_regprocedure('app.guard_curated_template_descriptor()'))
  and (select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum)
    from pg_attribute a where a.attrelid=to_regclass('app.workflow_template_origins') and a.attnum>0 and not a.attisdropped)
    =array['workspace_id:uuid','workflow_id:uuid','origin:jsonb']::text[]
  and exists(select 1 from pg_class c where c.oid=to_regclass('app.workflow_template_origins')
    and c.relrowsecurity and c.relforcerowsecurity)
  and (select count(*)=2 from pg_policy p where p.polrelid=to_regclass('app.workflow_template_origins'))
  and exists(select 1 from pg_policy p where p.polrelid=to_regclass('app.workflow_template_origins')
    and p.polname='workflow_template_origins_tenant' and p.polcmd='r' and p.polpermissive
    and p.polroles=array[(select oid from pg_roles where rolname=$3)]::oid[]
    and pg_get_expr(p.polqual,p.polrelid)='((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
    and p.polwithcheck is null)
  and exists(select 1 from pg_policy p where p.polrelid=to_regclass('app.workflow_template_origins')
    and p.polname='workflow_template_origins_owner' and p.polcmd='*' and p.polpermissive
    and p.polroles=array[(select oid from pg_roles where rolname=$1)]::oid[]
    and pg_get_expr(p.polqual,p.polrelid)='true' and pg_get_expr(p.polwithcheck,p.polrelid)='true')
  and exists(select 1 from pg_constraint c where c.conrelid=to_regclass('app.workflow_template_origins')
    and c.contype='p' and pg_get_constraintdef(c.oid)='PRIMARY KEY (workspace_id, workflow_id)')
  and exists(select 1 from pg_constraint c where c.conrelid=to_regclass('app.workflow_template_origins')
    and c.contype='f' and c.convalidated and c.confrelid=to_regclass('app.workflows')
    and pg_get_constraintdef(c.oid)='FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE')
)`;
