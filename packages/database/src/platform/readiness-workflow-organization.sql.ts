// ADR064: catalog-only exact inventory. This never enables the independent writer.
// Role OIDs are normalized to configured capability names for cross-cluster parity.
export const WORKFLOW_ORGANIZATION_CATALOG_SQL = `
with configured_roles as (select $1::text owner_role,$2::text worker_role,$3::text api_role), relations as (
  select c.* from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='app' and c.relname=any(array[
    'workflow_organization_rollout','workflow_organization_coordination','workflow_tags',
    'workflow_organization_state','workflow_tag_assignments',
    'workflow_favorite_membership_generations','workflow_favorites',
    'workflow_favorite_held_evidence','workflow_organization_receipts','workflow_favorite_receipts'])
), inventory as (
  select c.relname,jsonb_build_object(
    'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
    'partition',c.relispartition,
    'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attidentity,a.attgenerated,co.collname,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      left join pg_collation co on co.oid=a.attcollation
      where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(k.conname,k.contype,k.convalidated,
      k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid)) order by k.conname collate "C")
      from pg_constraint k where k.conrelid=c.oid),
    'indexes',(select jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,
      i.indisready,i.indislive,i.indisunique,i.indisprimary,i.indisexclusion)
      order by pg_get_indexdef(i.indexrelid) collate "C") from pg_index i where i.indrelid=c.oid),
    'policies',(select jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
      (select jsonb_agg(case when r.rolname=$1 then 'owner_role' when r.rolname=$3 then 'api_runtime_role'
        else coalesce(r.rolname,'PUBLIC') end order by r.rolname collate "C")
        from unnest(p.polroles) role_id left join pg_roles r on r.oid=role_id),
      pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname collate "C")
      from pg_policy p where p.polrelid=c.oid),
    'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid)||':'||t.tgenabled::text order by t.tgname collate "C")
      from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  ) body from relations c
)
select encode(sha256(convert_to(jsonb_build_object(
  'relations',coalesce(jsonb_agg(body order by relname collate "C"),'[]'::jsonb),
  'functions',(select jsonb_agg(jsonb_build_array(signature,l.lanname,p.prokind,
    pg_get_function_result(p.oid),pg_get_function_identity_arguments(p.oid),
    pg_get_function_arguments(p.oid)) order by signature collate "C")
    from unnest(array[
      'app.current_workflow_favorite_generation()',
      'app.invalidate_workflow_favorite_membership()',
      'app.lock_workflow_organization_authority(text[])',
      'app.lock_workflow_organization_coordination(boolean)',
      'app.lock_workflow_organization_for_lifecycle()',
      'app.assert_workflow_organization_writes_enabled()',
      'app.claim_workflow_organization_command(text,uuid,text,jsonb)',
      'app.complete_workflow_organization_command(text,uuid,text,jsonb)',
      'app.record_workflow_organization_audit(text,uuid,jsonb)',
      'app.execute_workflow_tag_command(text,uuid,text,jsonb)',
      'app.execute_workflow_tag_assignment_command(text,uuid,text,jsonb)',
      'app.lock_workflow_favorite_generation(boolean)',
      'app.read_workflow_favorite_generation()',
      'app.workflow_favorite_command_body(jsonb)',
      'app.prepare_workflow_favorite_command(uuid,text,jsonb)',
      'app.execute_workflow_favorite_command(uuid,text,jsonb,uuid,bigint,bigint)',
      'app.reap_workflow_organization(integer)',
      'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)',
      'app.execute_workspace_tenant_rows_page_before_organization(uuid,uuid,bigint,integer,bigint,character)'
    ]) signature join pg_proc p on p.oid=to_regprocedure(signature)
    join pg_language l on l.oid=p.prolang)
)::text,'UTF8')),'hex')
from inventory`;

export const READINESS_WORKFLOW_ORGANIZATION_SQL = `(
  (${WORKFLOW_ORGANIZATION_CATALOG_SQL})='fe64dc5bcca4282be6e6cfd8ffa8cda06538755cad374dfcedffa4d0061e8bf7'
  and (select count(*)=10 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='app' and c.relname=any(array[
      'workflow_organization_rollout','workflow_organization_coordination','workflow_tags',
      'workflow_organization_state','workflow_tag_assignments','workflow_favorite_membership_generations',
      'workflow_favorites','workflow_favorite_held_evidence','workflow_organization_receipts','workflow_favorite_receipts'])
    and c.relowner=(select oid from pg_roles where rolname=$1)
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where a.grantee<>c.relowner and (a.grantee<>(select oid from pg_roles where rolname=$3)
        or c.relname not in ('workflow_organization_rollout','workflow_tags','workflow_organization_state',
          'workflow_tag_assignments','workflow_favorites','workflow_favorite_receipts')
        or a.privilege_type<>'SELECT' or a.is_grantable))
    and has_table_privilege($3,c.oid,'SELECT')=(c.relname in ('workflow_organization_rollout','workflow_tags',
      'workflow_organization_state','workflow_tag_assignments','workflow_favorites','workflow_favorite_receipts'))
    and not exists(select 1 from pg_attribute column_grant,lateral aclexplode(column_grant.attacl) a
      where column_grant.attrelid=c.oid and a.grantee<>c.relowner))
  and (select count(*)=18 from (values
    ('app.current_workflow_favorite_generation()','a4ba15974e37062666297f2b0e793448',true,'s','api'),
    ('app.invalidate_workflow_favorite_membership()','011b8addaf75da048217315f3d11ee65',true,'v','owner'),
    ('app.lock_workflow_organization_authority(text[])','dd640fd299b3fb92e5cba1ca92d484fa',true,'v','owner'),
    ('app.lock_workflow_organization_coordination(boolean)','20c69673ebc95f65fed0925b0a2aea65',true,'v','owner'),
    ('app.lock_workflow_organization_for_lifecycle()','84e16158cd9eb33a9901351442ca84f0',true,'v','api'),
    ('app.assert_workflow_organization_writes_enabled()','50adb63a3d2b45cbaf9ee5f03cdaa219',true,'v','owner'),
    ('app.claim_workflow_organization_command(text,uuid,text,jsonb)','e0f678da45e247a18f8b88ac90018cc1',true,'v','owner'),
    ('app.complete_workflow_organization_command(text,uuid,text,jsonb)','443f524502e47d4dabab980c36b851ac',true,'v','owner'),
    ('app.record_workflow_organization_audit(text,uuid,jsonb)','d33dcbcee46660d442a603da8ea9a5d3',true,'v','owner'),
    ('app.execute_workflow_tag_command(text,uuid,text,jsonb)','b01ed13a79450ab9aeb010019ba88b8a',true,'v','api'),
    ('app.execute_workflow_tag_assignment_command(text,uuid,text,jsonb)','b7c05a18e83651e2b44c17fa719739ec',true,'v','api'),
    ('app.lock_workflow_favorite_generation(boolean)','d0a99782311bc3c4eb5add077fb97783',true,'v','owner'),
    ('app.read_workflow_favorite_generation()','a258c9982638b08c4f33c4beace99291',true,'v','api'),
    ('app.workflow_favorite_command_body(jsonb)','1bc876edcea6aa3bab09c59a2989dd87',false,'i','owner'),
    ('app.prepare_workflow_favorite_command(uuid,text,jsonb)','be7fbe4a3f2c0f881247c0ca08330d5d',true,'v','api'),
    ('app.execute_workflow_favorite_command(uuid,text,jsonb,uuid,bigint,bigint)','0a73807e8a209b01456fcc9a7393b7c3',true,'v','api'),
    ('app.reap_workflow_organization(integer)','9e62ca1ae4dcbf36b7f30879a9e7c91e',true,'v','maintenance'),
    ('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)','04650e6c8360b75173a63d34265f7aa0',true,'v','maintenance')
  ) expected(signature,body_hash,definer,volatility,capability)
    join pg_proc p on p.oid=to_regprocedure(expected.signature)
    where p.proowner=(select oid from pg_roles where rolname=$1)
      and p.prosecdef=expected.definer and p.provolatile::text=expected.volatility
      and md5(p.prosrc)=expected.body_hash and not p.proleakproof and not p.proisstrict
      and p.proparallel='u'
      and p.proconfig=case when expected.definer
        then array['search_path=pg_catalog, pg_temp','row_security=on']::text[]
        else array['search_path=pg_catalog, pg_temp']::text[] end
      and has_function_privilege($3,p.oid,'EXECUTE')=(expected.capability='api')
      and has_function_privilege($4::name,p.oid,'EXECUTE')=(expected.capability='maintenance')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee<>p.proowner and (a.grantee<>case expected.capability
          when 'api' then (select oid from pg_roles where rolname=$3)
          when 'maintenance' then (select oid from pg_roles where rolname=$4) else p.proowner end
          or a.privilege_type<>'EXECUTE' or a.is_grantable)))
  and exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('app.workspace_memberships')
    and t.tgname='workflow_favorite_membership_departure' and not t.tgisinternal and t.tgenabled='O'
    and t.tgtype=17 and t.tgfoid=to_regprocedure('app.invalidate_workflow_favorite_membership()')
    and t.tgattr::text=(select attnum::text from pg_attribute
      where attrelid=t.tgrelid and attname='status') and t.tgqual is null and octet_length(t.tgargs)=0)
)`;
