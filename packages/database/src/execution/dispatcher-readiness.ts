import type { Pool } from 'pg';

import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from '../platform/readiness.js';

export async function checkDispatcherReadiness(
  pool: Pool,
  ownerRole: string,
): Promise<void> {
  const result = await pool.query<{
    can_delete: boolean;
    can_insert: boolean;
    can_select: boolean;
    can_update_required: boolean;
    can_update_immutable: boolean;
    can_update_table: boolean;
    dispatch_index_compatible: boolean;
    dispatcher_policy_count: number;
    fair_cursor_compatible: boolean;
    migration_head: string | null;
    owner_member: boolean;
    policy_count: number;
    postgres_major: number;
    relforcerowsecurity: boolean;
    relrowsecurity: boolean;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>(
    `
      select
        current_setting('server_version_num')::integer / 10000 as postgres_major,
        role.rolsuper,
        role.rolbypassrls,
        pg_has_role(current_user, $1::name, 'MEMBER') as owner_member,
        table_class.relrowsecurity,
        table_class.relforcerowsecurity,
        has_table_privilege(current_user, table_class.oid, 'SELECT') as can_select,
        not exists (
          select 1
          from unnest(array[
            'available_at','lease_owner','lease_token','lease_expires_at',
            'publish_attempts','published_at','failed_at','last_error_code','updated_at'
          ]) required_column(name)
          where not has_column_privilege(
            current_user, table_class.oid, required_column.name, 'UPDATE'
          )
        ) as can_update_required,
        has_table_privilege(current_user, table_class.oid, 'UPDATE') as can_update_table,
        exists (
          select 1
          from pg_attribute attribute
          where attribute.attrelid = table_class.oid
            and attribute.attname = any(array[
              'id',
              'workspace_id',
              'job_name',
              'schema_version',
              'aggregate_type',
              'aggregate_id',
              'payload',
              'payload_checksum',
              'created_at'
            ])
            and has_column_privilege(
              current_user,
              table_class.oid,
              attribute.attnum,
              'UPDATE'
            )
        ) as can_update_immutable,
        has_table_privilege(current_user, table_class.oid, 'INSERT') as can_insert,
        has_table_privilege(current_user, table_class.oid, 'DELETE') as can_delete,
        exists (
          select 1
          from pg_index index_state
          join pg_class index_class on index_class.oid=index_state.indexrelid
          join pg_am access_method on access_method.oid=index_class.relam
          where index_state.indrelid=table_class.oid
            and index_class.relname='outbox_events_dispatch_job_due_idx'
            and index_state.indisvalid and index_state.indisready
            and not index_state.indisunique
            and index_state.indnkeyatts=3 and index_state.indnatts=3
            and access_method.amname='btree'
            and pg_get_indexdef(index_state.indexrelid,1,true)='job_name'
            and pg_get_indexdef(index_state.indexrelid,2,true)='available_at'
            and pg_get_indexdef(index_state.indexrelid,3,true)='id'
            and pg_get_expr(index_state.indpred,index_state.indrelid)
                ='((published_at IS NULL) AND (failed_at IS NULL))'
        ) as dispatch_index_compatible,
        (
          to_regclass('app.outbox_fair_dispatch_cursor') is not null
          and (select count(*)=1 from app.outbox_fair_dispatch_cursor where singleton)
          and has_table_privilege(current_user,'app.outbox_fair_dispatch_cursor','SELECT')
          and has_column_privilege(current_user,'app.outbox_fair_dispatch_cursor','last_workspace_id','UPDATE')
          and has_column_privilege(current_user,'app.outbox_fair_dispatch_cursor','updated_at','UPDATE')
          and not has_column_privilege(current_user,'app.outbox_fair_dispatch_cursor','singleton','UPDATE')
          and not has_table_privilege(current_user,'app.outbox_fair_dispatch_cursor','INSERT')
          and not has_table_privilege(current_user,'app.outbox_fair_dispatch_cursor','DELETE')
          and has_function_privilege(current_user,'app.reserve_workflow_run_active_admission(uuid,uuid,uuid)','EXECUTE')
          and has_function_privilege(current_user,'app.workflow_run_active_admission_eligible(uuid,uuid,uuid)','EXECUTE')
          and has_function_privilege(current_user,'app.release_dispatcher_workflow_run_active_admission(uuid,uuid)','EXECUTE')
          and has_function_privilege(current_user,'app.arm_dispatcher_workflow_run_active_admission(uuid,uuid)','EXECUTE')
          and has_function_privilege(current_user,'app.recover_due_workflow_run_active_admissions(integer)','EXECUTE')
        ) as fair_cursor_compatible,
        (
          select count(*)::integer
          from pg_policy policy
          where policy.polrelid = table_class.oid
            and role.oid = any(policy.polroles)
        ) as dispatcher_policy_count,
        (
          select count(*)::integer
          from pg_policy policy
          where policy.polrelid = table_class.oid
            and role.oid = any(policy.polroles)
            and policy.polpermissive
            and (
              (policy.polname='outbox_events_dispatcher_select'
                and policy.polcmd='r'
                and pg_get_expr(policy.polqual,policy.polrelid)='true'
                and policy.polwithcheck is null)
              or
              (policy.polname='outbox_events_dispatcher_update'
                and policy.polcmd='w'
                and pg_get_expr(policy.polqual,policy.polrelid)='true'
                and pg_get_expr(policy.polwithcheck,policy.polrelid)='true')
            )
        ) as policy_count,
        (
          select name
          from pertexo_internal.schema_migrations
          order by name desc
          limit 1
        ) as migration_head
      from pg_roles role
      join pg_class table_class on table_class.oid = 'app.outbox_events'::regclass
      where role.rolname = current_user
    `,
    [ownerRole],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.postgres_major < MINIMUM_POSTGRES_MAJOR ||
    row.migration_head !== EXPECTED_MIGRATION_HEAD ||
    !row.relrowsecurity ||
    !row.relforcerowsecurity ||
    !row.can_select ||
    !row.can_update_required ||
    row.can_update_immutable ||
    row.can_update_table ||
    row.can_insert ||
    row.can_delete ||
    !row.dispatch_index_compatible ||
    !row.fair_cursor_compatible ||
    row.policy_count !== 2 ||
    row.dispatcher_policy_count !== 2 ||
    row.rolsuper ||
    row.rolbypassrls ||
    row.owner_member
  ) {
    throw new Error('Outbox dispatcher database boundary is incompatible');
  }
}
