import type { Pool } from 'pg';
import { withPlatformTransaction } from '../../tenant-access/workspace.js';
import { checkInboxCaptureReadiness } from './capture-readiness.js';

const readinessSql = `select (
  current_user=$2::name
  and not exists (
    select 1 from (values
      ('claim_workspace_inbox_projection(uuid,uuid,uuid,character,character varying,uuid)','461ca8f68b295fc5def2b8bc3c748e9e'),
      ('project_workspace_inbox_page(uuid,uuid,uuid,bigint)','e608fd0d3fad1b88f2cc77b21a2ab5db'),
      ('fail_workspace_inbox_projection(uuid,uuid,uuid,bigint)','b07b2af1e04b44f460ecc8ca6b16a69f')
    ) required(signature,body_hash)
    where not exists (
      select 1 from pg_proc command where command.oid=to_regprocedure('app.'||required.signature)
        and pg_get_userbyid(command.proowner)=$1 and command.prosecdef
        and md5(command.prosrc)=required.body_hash
        and command.proconfig=array['search_path=pg_catalog, app','row_security=on']
        and has_function_privilege(current_user,command.oid,'EXECUTE')
        and not exists (select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) acl
          where acl.privilege_type='EXECUTE' and acl.grantee<>command.proowner
            and acl.grantee<>(select oid from pg_roles where rolname=$2::name))
    )
  )
  and not exists(select 1 from (values
    ('workspace_inbox_audience'),('workspace_inbox_recipient_state'),('workspace_inbox_entries')
  ) protected(table_name) where has_table_privilege(current_user,'app.'||table_name,'INSERT'))
  and not exists(select 1 from (values
    ('workspace_inbox_sources','status'),('workspace_inbox_sources','captured_at'),
    ('workspace_inbox_sources','audience_count'),('workspace_inbox_sources','last_recipient_user_id'),
    ('workspace_inbox_sources','consecutive_attempts'),('workspace_inbox_sources','next_attempt_at'),
    ('workspace_inbox_sources','fence_token'),('workspace_inbox_sources','lease_owner'),
    ('workspace_inbox_sources','lease_token'),('workspace_inbox_sources','lease_expires_at'),
    ('workspace_inbox_sources','updated_at'),('workspace_inbox_audience','status'),
    ('workspace_inbox_audience','processed_at'),('workspace_inbox_recipient_state','revision')
  ) protected(table_name,column_name) where has_column_privilege(current_user,'app.'||table_name,column_name,'UPDATE'))
  and not exists(select 1 from (values('users'),('workspace_memberships')) protected(table_name)
    where has_any_column_privilege(current_user,'app.'||table_name,'SELECT,INSERT,UPDATE'))
  and not exists(select 1 from (values
    ('workspace_inbox_sources'),('workspace_inbox_audience'),
    ('workspace_inbox_recipient_state'),('workspace_inbox_entries')
  ) required(table_name) where not exists(
    select 1 from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='app' and relation.relname=required.table_name
      and relation.relrowsecurity and relation.relforcerowsecurity
  ))
) compatible`;

export async function checkInboxProjectionReadiness(
  pool: Pool,
  ownerRole: string,
  workerRole: string,
  signal?: AbortSignal,
): Promise<void> {
  await checkInboxCaptureReadiness(pool, ownerRole, workerRole, signal);
  await withPlatformTransaction(
    pool,
    async (client) => {
      const result = await client.query<{ compatible: boolean }>(readinessSql, [
        ownerRole,
        workerRole,
      ]);
      if (result.rows[0]?.compatible !== true)
        throw new Error('Inbox projection command authority is incompatible');
    },
    {
      ...(signal === undefined ? {} : { signal }),
      statementTimeoutMillis: 1_000,
    },
  );
}
